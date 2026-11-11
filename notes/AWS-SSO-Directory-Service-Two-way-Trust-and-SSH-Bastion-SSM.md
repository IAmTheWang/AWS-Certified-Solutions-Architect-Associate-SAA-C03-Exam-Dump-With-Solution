# AWS SSO + Directory Service 双向信任 & SSH vs 堡垒机 vs SSM 笔记

背景:一道经典 SAA/SAP 多账号 SSO + 混合云 AD 题(正确答案 B)的解析,以及顺带梳理的 SSH / Bastion Host / SSM Session Manager 三种"连服务器"方式的区别。两部分都围绕"身份与访问",放在一起复习。

---

## 一、题目:Organizations + SSO + 本地 AD,为什么选 B

### 题目场景

- 公司有多个 AWS 账号,由 **AWS Organizations** 统一管理
- 安全团队要求 **SSO(单点登录)**
- 员工账号继续放在 **本地自建 Microsoft AD(Active Directory)**,不想在云端重建

### 考点拆解(三个知识点的组合)

| # | 考点 | 对应 AWS 服务 |
|---|------|--------------|
| 1 | 多账号统一访问 | AWS Organizations + **AWS SSO**(现已更名 **AWS IAM Identity Center**) |
| 2 | 保留本地 AD、不重建账号 | **AWS Directory Service(AWS Managed Microsoft AD)** 作为云与本地 AD 的桥梁 |
| 3 | **信任关系方向**(A vs B 的分水岭) | 必须建立 **双向(Two-way)林信任** |

### 为什么必须是双向信任(A 单向 ✗)

AWS SSO 不只是"验证密码对不对",登录前还需要向本地 AD **发起查询(Query)**,读取用户、用户组及其属性元数据。

- **单向信任**:只有一侧能信任/查询另一侧,AWS SSO 拿不到读取本地 AD 用户/组所需的权限 → 不满足
- **双向林信任(Two-way forest trust)**:两侧互相可见 → AWS SSO 才能同步/查询用户与组

### 选项排除表

| 选项 | 问题 |
|------|------|
| **A** | 只建了单向信任。普通应用验证或许可行,但 AWS SSO 需要双向 |
| **B ✅** | Directory Service + **启用 AWS SSO** + **双向林信任** |
| **C** | 只建了 Directory Service,**没启用 AWS SSO**,无法实现跨所有账号的 SSO |
| **D** | 要在本地自建并维护 SAML 2.0 IdP(如 ADFS),运维成本高,且没用到 Directory Service 这个标准集成方案 |

### 一句话记忆

> **多账号 + SSO + 保留本地 AD = Directory Service + AWS SSO(Identity Center) + 双向信任。** 看到"单向信任"优先怀疑是陷阱;看到"自建 SAML IdP/ADFS"优先怀疑运维成本过高。

### 类比:SSO = 集团"一卡通万能工牌"

公司有 50 个 AWS 账号 = 50 个独立分部园区。

- **没有 SSO**:进 A 园区一套账号密码,进 B 园区又一套;员工离职时管理员要去 50 个地方逐一注销
- **有 SSO**:早上在集团总部打卡一次,拿这张工牌刷开所有 50 个园区;离职时总部封一次工牌,所有权限瞬间收回

---

## 二、SSH / 堡垒机 / SSM:三种"进服务器"的方式

类比:内网服务器(EC2)= 军事园区深处放核心机密的科研楼;运维/研发人员 = 需要进楼维护设备的人。

### 1. SSH

**类比:每栋楼后墙上开的一扇"22 号专用小铁门"。**

- **怎么工作**:Linux 服务器默认开 22 端口,你持 SSH Key(私钥)插进去,核对通过就能进入敲命令
- **致命痛点**:如果每台机器的 22 端口都直接对公网(公网 IP)开放,全世界的黑客都能看到这扇门,天天暴力破解扫描;一旦某台 key 泄露,整台机器沦陷

### 2. 堡垒机(Bastion Host / 跳板机)

**类比:园区大门口唯一的"武装传达室 / 保安亭"。**

- **怎么工作**:把所有大楼对外的门封死,只在园区正门设一个保安亭
  1. 先从外面 SSH 登录堡垒机
  2. 堡垒机核实身份、记录行为(审计日志)
  3. 再从堡垒机经内网"地下走廊"跳到后面的目标服务器
- **痛点**:
  - **还是得开门**:堡垒机本身仍然是对公网开放 22 端口的机器,依然是被攻击面
  - **花冤枉钱**:堡垒机本身就是一台 EC2,不管用不用,每月都在计费

### 3. SSM Session Manager(AWS Systems Manager)

**类比:内部专属"对讲机 + 空间传送门"。**

- **怎么工作**:
  - **外门全部焊死**:安全组 **22 端口彻底关闭,0 入站端口**
  - **楼内驻场联络员**:每台实例里装 **SSM Agent**,它不接听任何外来敲门,只**主动向外**(向 AWS 总部)汇报/保持连接
  - **进门方式**:你登录 AWS 控制台(或 AWS CLI),出示 **IAM 身份**;AWS 验证通过后,直接在云端把你的终端与实例里的 Agent 接通
- **相比堡垒机的优势**:
  - **更安全**:外部扫描器看不到任何开放端口
  - **更省钱**:不再需要堡垒机这台 EC2,可直接拆除(例:测试环境跳板机)
  - **自带审计**:会话可记录到 CloudTrail / CloudWatch Logs / S3,权限由 IAM 控制,不用管理 SSH key

### 对照表

| 维度 | 直接 SSH | 堡垒机 | SSM Session Manager |
|------|---------|--------|---------------------|
| 入站端口 | 每台机器开 22 | 只有堡垒机开 22 | **0 个** |
| 是否需要公网入口 | 是 | 是(堡垒机) | **否** |
| 额外 EC2 成本 | 无 | **有** | **无** |
| 认证方式 | SSH Key | SSH Key | **IAM 身份** |
| 审计 | 需自建 | 靠堡垒机日志 | CloudTrail/CloudWatch/S3 原生 |
| 前提 | 密钥管理 | 维护堡垒机 | 实例装 SSM Agent + 有 IAM Instance Profile(也可配 VPC Endpoint 走纯内网) |

### 考试速记

> 题干出现 "**不开放入站端口 / 无需管理 SSH key / 无需堡垒机 / 审计会话 / 降低成本**" → 首选 **SSM Session Manager**。

---

## 三、两部分的共同主线

两块内容其实都在解决"**谁能进来、怎么证明身份、怎么统一管理**":

- SSO + Directory Service:解决**人 → AWS 账号**的统一身份(身份源仍在本地 AD)
- SSM Session Manager:解决**人 → EC2 实例**的安全进入(用 IAM 身份代替 SSH key + 开放端口)

---

## 相关笔记

- 堡垒机与 ALB 在 VPC 中的位置关系:[ALB-vs-API-Gateway-vs-Bastion-Host.md](./ALB-vs-API-Gateway-vs-Bastion-Host.md)
- IAM 权限评估逻辑:[IAM-Policy-Evaluation-and-CIDR-Notation.md](./IAM-Policy-Evaluation-and-CIDR-Notation.md)
- 无公网访问 AWS 服务(SSM 走 Interface Endpoint):[VPC-Endpoint-Gateway-vs-Interface-vs-NAT-Gateway.md](./VPC-Endpoint-Gateway-vs-Interface-vs-NAT-Gateway.md)
