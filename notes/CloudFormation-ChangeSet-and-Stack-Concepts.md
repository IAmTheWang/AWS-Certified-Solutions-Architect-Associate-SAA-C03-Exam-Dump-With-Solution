# CloudFormation Change Set 与 Stack 核心概念笔记

## 一、Change Set（变更集）是什么

**Change Set** 是 CloudFormation 提供的"预演 / 体检报告"机制：在真正执行 `update-stack` 之前，先让 CFn 拿"新模板"跟"当前 Stack 的真实状态"做一次 diff，生成一份清单，明确告诉你这次更新会对每个资源做什么操作——**Add（新增）/ Modify（原地修改）/ Replace（先删除后重建）**。

### 为什么需要这一步

CloudFormation 有些属性修改可以"原地更新"（比如改一下 Tag、调整 Security Group 规则），但有些属性一改就会触发**隐式替换（Replace）**——也就是"先删除旧资源，再创建一个新的"。如果这个资源正好是**有状态资源**（比如挂着业务数据的 RDS 数据库、EBS 卷），一次没注意到的 Replace 就等于把生产数据直接删没了。

Change Set 的核心价值，就是把这种"要删除重建"的操作**提前摆到台面上让你看见**（英文常说 "a change set **surfaces** the replacement"——这里 surface 是动词"摆到表面上 / 曝光"的意思，不是"表面 / 外观"的名词用法）。确认没问题了，再手动点 "Execute Change Set" 去真正执行；如果发现某个资源要被 Replace 而这不是你想要的，可以直接放弃这次变更，回去改模板（比如给该资源加 `DeletionPolicy: Retain`，或调整属性避免触发替换）。

### 有无 Change Set 的对比

| | 直接 `update-stack`（没有 Change Set） | 用了 Change Set |
|---|---|---|
| 执行前能否看到"是否会删重建" | ❌ 看不到，执行到那一步才知道 | ✅ 提前看到完整清单 |
| 误删有状态资源的风险 | 高 | 低（可以提前叫停） |
| 是否是必经步骤 | 是唯一方式（Change Set 出现之前的 CFn） | 可选的额外安全步骤 |

## 二、Change Set 是不是在"模仿" Terraform plan？

功能定位上，两者确实高度重合——都是"先算出一份改动清单，人确认没问题，再真正执行"的安全阀设计。

**时间线上这个猜测站得住脚**：Terraform 从 2014 年发布起，`plan` 就是核心工作流的一部分（设计之初就是 "plan 再 apply" 这套哲学）。CloudFormation 本身 2011 年就有了，但 **Change Set 是后来才加进去的**（约 2016 年前后）——也就是说 Change Set 出现之前，CloudFormation 的 `update-stack` 是没有预演这一步的，只能直接执行，执行到哪个资源要被替换才会发现。所以从时间顺序看，"CFn 后来补上了 Terraform 一开始就有的能力"这个推测是站得住脚的。

不过这只是基于时间线和行业常识的合理推测，没有查到 AWS 官方明确承认"照着 Terraform 做的"这类说法——动机层面的"抄没抄"通常很难找到一手证据，这块算合理推断，不是已证实的事实。

### 两者的实际差异

| 维度 | CloudFormation Change Set | Terraform plan |
|---|---|---|
| 状态管理模型 | 直接对比"当前 Stack 真实状态" vs "新模板"，没有对用户暴露独立 state 文件的概念 | 自己维护一份 state 文件，`plan` 是"state 文件 + 刷新后的真实资源状态 + 新配置"三方 diff |
| 适用范围 | 仅 AWS 自家资源 | 跨云 / 跨供应商（AWS、GCP、Azure，甚至 SaaS API 都能管） |
| 是否强制 | 可选，能跳过直接 `update-stack` | 事实上的默认工作流（哪怕直接 `apply` 也会先跑一遍 plan 再问 confirm，除非 `-auto-approve`） |

**SAA 考试范围提醒**：Change Set 是 AWS 原生概念，SAA 会考，而且是 CloudFormation 章节里比较高频的考点；Terraform 属于第三方工具，SAA **不考**——SAA 是 AWS 专属认证，Terraform 有自己独立的认证体系（HashiCorp 的 "Terraform Associate"），两者是分开的考试，实战中 Terraform 用得再多，也不会出现在 SAA 题目里。

## 三、Stack / 有状态资源 / EBS / Stack Policy —— 用"宜家家具说明书"理解

把 CloudFormation 想象成宜家（IKEA）的一套说明书体系：

- **模板（Template）** = 一份宜家家具组装说明书，写清楚要用几块木板、几颗螺丝，怎么拼。
- **Stack（堆栈）** = 照着说明书实际拼出来的那件家具本身。同一份说明书可以拼出好几件一样的家具，对应现实中可以用同一个模板创建多个 Stack（比如 dev/stg/prd 三套环境各自一个 Stack）。
- **有状态资源（Stateful Resource）** = 家具里"装了东西"的部分，比如已经放满书的书架、已经存了水的鱼缸——一旦被"拆了重装"，里面装的东西就没了。对应 RDS 数据库、EBS 卷、S3 Bucket 这类保存业务数据的资源，跟无状态的 Lambda 函数、ECS 任务定义完全不同——后者删了重建毫无损失，前者删了重建等于丢数据。这也是第一节里 Change Set 要重点防的风险。
- **EBS（Elastic Block Store）** = 挂在 EC2 上的一块"移动硬盘"，是最典型的有状态资源之一，装的是操作系统盘或业务数据盘的实际内容。
- **Stack Policy（堆栈策略）** = 贴在某件家具上的一张纸条，写着"不管说明书后面怎么改，这个书架不许被拆掉重装"——在模板层面上对特定资源（通常是有状态资源）加一层"禁止 Replace"的硬性保护，即使有人改了模板、发起了 `update-stack`，CFn 也会在执行阶段直接拒绝对这个资源做替换操作。跟 Change Set 是互补关系：Change Set 是"执行前主动看一眼"，Stack Policy 是"就算没看、或者看漏了，也有一道硬性闸门兜底"。

## 四、Nested Stack / StackSets / Drift Detection

延续宜家说明书的比喻：

- **Nested Stack（嵌套堆栈）** = 把一份特别厚的说明书拆分成好几本小册子（比如"椅子说明书""桌子说明书"），主说明书里写"先照小册子 A 拼、再照小册子 B 拼"。对应把一个巨大的 CFn 模板拆成多个子模板，用一个父 Stack 去引用 / 组合多个子 Stack，方便复用和维护，避免单个模板无限膨胀。
- **StackSets（堆栈集）** = 拿着同一份说明书，同时发给好几个不同的房间（对应不同 AWS 账号 / 不同 Region）去拼同样的家具。用于一次性把同一套基础设施批量部署到多账号、多区域，是企业级多账号治理常用的工具。
- **Drift Detection（漂移检测）** = 拿着说明书去房间里现场核对"实际拼出来的家具，是不是跟说明书写的一模一样"。如果有人手动拆了螺丝、加了个抽屉（也就是有人绕过 CFn，在 AWS 控制台里手动改了某个资源的配置），Drift Detection 就能把这种"跟 IaC 定义不一致"的手动改动检测出来——这也是为什么强调"基础设施要全部走 IaC，别手动改控制台"的原因：手动改的东西，Drift Detection 会把它标记出来，提醒你这里已经跟代码定义的状态不一致了。

### SAA 考频参考

Change Set、DeletionPolicy / UpdateReplacePolicy 这类"防止误删数据"相关的概念是较高频考点；Stack Policy 也在考纲内，但出现频率相对低一些；Nested Stack / StackSets / Drift Detection 也会考，属于中等频率。

---

参考关联笔记：[ALB-vs-API-Gateway-vs-Bastion-Host.md](ALB-vs-API-Gateway-vs-Bastion-Host.md)（第十一、十二节：welby-fhir-server-aggregator-platform 项目公网 / 内部 API 网络隔离设计实例）、[ECS-vs-Docker-vs-EC2-vs-Lambda.md](ECS-vs-Docker-vs-EC2-vs-Lambda.md)（第七、八节：Blue/Green vs Canary vs 滚动部署三者区别）
