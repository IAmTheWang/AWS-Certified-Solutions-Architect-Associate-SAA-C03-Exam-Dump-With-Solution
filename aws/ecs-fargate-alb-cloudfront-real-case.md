# ECS / Fargate / ALB / CloudFront 实战笔记(基于真实排查案例)

来源:在公司项目 mykarte 做"迁移到 S3+CloudFront 的成本对比"时,在 AWS 控制台里实查的一整套 ECS/ALB/CloudFront 拓扑。比刷题记概念更容易记住,建议直接对照 SAA 考点复习。

---

## 1. ECS 核心概念

| 概念 | 作用 | 类比 Kubernetes |
|---|---|---|
| **Cluster** | 逻辑分组/管理边界,把一批 Service 和 Task 装在一起统一管理、隔离、监控 | Cluster |
| **Service** | 保证"始终有 N 个副本在跑",处理滚动更新/蓝绿部署 | Deployment / ReplicaSet |
| **Task Definition** | 容器规格模板(镜像、Cpu/Memory、端口映射),每次改动生成新的 revision(版本号递增,旧版本不会被覆盖,只会变成 Inactive) | 类似 Pod Template |
| **Task** | 实际运行的最小单元,一个或多个 Container 共享网络 | **Pod** |
| **Container** | Task 里定义的单个 Docker 容器 | Pod 里的容器 |

**Cluster 的两种含义,取决于 launch type**:
- **EC2 launch type**:Cluster = 一批你自己管理的 EC2 实例(真实的"资源池",你要操心开几台、多大、扩缩容、打补丁)。
- **Fargate launch type**:Cluster 纯粹是"管理边界",底层机器完全被 AWS 隐藏,你看不到、不用管。

## 2. ECS vs Kubernetes/EKS

- **ECS**:AWS 自研的容器编排系统,只能管 AWS 资源,概念少、上手快、通常更便宜(没有额外控制面费用)。
- **EKS**:AWS 托管的 Kubernetes(每个集群有固定控制面月费)。
- **Kubernetes**:2014 年 Google 开源(内部前身叫 Borg,用了十几年),2015 年捐给 CNCF,变成厂商中立的行业标准。
- **为什么明明 ECS 更便宜还要用 K8s/EKS**:
  1. 不被单一云厂商锁死(vendor lock-in)——K8s 能在 AWS/Azure/GCP/自建机房跑同一套配置。
  2. 生态更大、人才池更大(Helm/Istio/ArgoCD、招人更容易)。
  3. 功能更强(StatefulSet、CRD/Operator、精细 RBAC),适合大规模复杂多团队平台。
  4. 公司整体已有 K8s 平台投入时,单独给某个服务上 ECS 反而增加维护复杂度。
- **学习成本高是真的**:K8s 概念数量(Pod/Deployment/Service/Ingress/ConfigMap/Secret/PV/RBAC/CNI/Helm...)远超 ECS,更容易踩坑,运维要求更高的专职投入。

## 3. Fargate vs EC2 launch type

**Fargate 不是"AWS 管理的 EC2",是无服务器(serverless)的容器运行环境**——比"托管 EC2"更进一步:

| | EC2 launch type | Fargate launch type |
|---|---|---|
| 底层机器 | 自己管理一批 EC2 实例(选 AMI、装 runtime、打补丁、扩缩容) | 完全托管,看不到、不用管 |
| 计费方式 | 按实例小时(不管有没有容器在跑) | 按 task 声明的 vCPU/Memory × 运行时长计费 |
| 类比 | "租了台电脑自己装软件" | "容器界的 Lambda" |

### Cpu / Memory 单位换算(常考!)
- **Cpu 单位**:1024 units = 1 vCPU。例:`256` = 256/1024 = **0.25 vCPU**。
- **Memory 单位**:单位是 **MiB**。例:`512` = **512MB(0.5GB)**。
- Fargate 只允许"合法组合表"里的 Cpu/Memory 搭配,不能随意组合(如 256 units 只能配 512/1024/2048 MiB)。
- **`256/512` 是 Fargate 能配的最小规格**——适合纯静态文件服务这类无计算需求的场景,再往下压缩不了了。

### Desired Count ≠ 请求量
- **Desired Count** 是"你希望常驻跑几个 task(副本)"的**容量配置**,不是流量指标。
- 计费公式:`月度成本 ≈ (vCPU单价×vCPU数 + Memory单价×GB数) × 运行小时数 × Desired Count`
- **重要坑**:CloudFormation/Terraform 源码里写的 DesiredCount 不代表线上真实值——尤其当 `DeploymentController: CODE_DEPLOY`(蓝绿部署)时,实际数量由 CodeDeploy 管理,IaC 源码里的初始值可能跟线上有 drift(漂移)。**必须去 ECS Console → Cluster → Service/Tasks 页面看实时数字,不能信源码。**

### Fargate task 的私有 IP 生命周期
- Task **启动**时分配一个 ENI + 私有 IP,**跟这个 task 生命周期完全绑定**。
- Task 被终止(部署换版本/扩缩容/健康检查失败重启)→ IP 立刻释放,新 task 拿到**全新的、不同的**IP。
- 没有固定"多久"的说法,纯粹跟着 task 生死走。
- ECS 会**自动**把新 IP 注册进 ALB 的 Target Group、把旧 IP 摘掉,不需要手动维护。
- 对比 **EC2 实例的私有 IP**:只要实例不被 Terminate、不手动改 ENI,私有 IP **在整个实例生命周期内保持不变**(Stop/Start 也不影响私有 IP,只有自动分配的公有 IP 才会变)。这是 EC2 和容器化最大的行为差异之一——"EC2 是宠物(养一台长期用),容器是牲畜(随时可以杀了重建)"。

## 4. ALB(Application Load Balancer)

### ALB 存在的意义
- 当后端是**多个有容量上限、互相独立的复制品**(比如 N 个 Fargate task)时,需要有人决定"这个请求该发给谁"、做健康检查、挂了自动摘除——这就是 ALB。
- **S3 为什么不需要 ALB**:S3 不是"N 个有容量上限的实例",是 AWS 内部近乎无限扩展的单一托管存储服务,没有"选哪个实例"这个问题存在的前提。CloudFront 也不是传统意义的"多后端负载均衡",它是缓存层,只有一个逻辑源(S3),不需要做"选择"。

### Listeners → Rules → Target Groups → Targets(层级关系)
```
ALB
 └─ Listener(监听端口,如 HTTP:80 / HTTPS:443)
     └─ Rule(按 Priority 从小到大依次匹配,第一条命中就执行,不匹配则走 default 兜底)
         ├─ Condition(如 Path Pattern / Host Header)
         └─ Action(Forward to target group / Redirect / Fixed response)
             └─ Target Group(逻辑分组,配健康检查、协议端口)
                 └─ Target(实际的 IP:port / EC2 instance / Lambda)
```
- **Target Group 本身不是服务器**,是"收件人名单";**Target 才是真正接收请求的端点**。
- Target Group 类型:`instance`(EC2实例ID)/ `ip`(IP地址,Fargate 必用这种,因为没有固定实例概念)/ `lambda`。
- **一个 ALB 可以同时服务多个完全不同的后端**(比如我们案例里,同一个 ALB 上,一个 Target Group 指向 mykarte 的 Fargate 前端,另一个 Target Group 指向一台完全独立的 m5.xlarge EC2 服务器)——**排查时不能只看"这个 Service 用了哪个 Target Group",要去 ALB 详情页的 "Resource map" 看全貌**,才知道是否共享。
- **ALB 共享时的成本处理**:只关掉/删除自己的 Target Group 和对应 Rule,能省下"自己那部分流量对应的 LCU 用量费",**但省不下 ALB 本身的固定小时费**——除非其他 Target 也一起下线,整个 ALB 才能真正省掉。

### LCU(Load Balancer Capacity Unit)
- ALB 计费 = **固定小时费**(存在就要付,跟流量无关) + **LCU 用量费**。
- LCU 打包了 4 个维度,**每小时按 4 个维度里最高的那个算钱,不是相加**:
  1. 新建连接数/秒
  2. 活跃连接数
  3. 处理字节数(吞吐量)
  4. 规则评估次数/秒(规则越多、请求越多,这个越高)
- 具体每小时用了多少 LCU 没法靠公式估,**要去 Cost Explorer 查真实历史账单**才准。

## 5. IaC:CloudFormation vs Terraform

- **CFN = CloudFormation** 的圈内简写(取 Cloud**F**ormatio**N** 的 C/F/N,主要是为了跟 CloudFront 的简写 "CF" 区分开,避免混淆)。
- **CloudFormation**:AWS 自己的 IaC 服务,**只能管理 AWS 资源**。
- **Terraform**:HashiCorp 出的**跨云通用** IaC 工具,靠 provider 插件对接 AWS/Azure/GCP,能在一个项目里管跨云资源。
- **两套工具同时管理同一批资源的风险 —— Drift(漂移)**:比如有人在控制台手动改了、或用 CFN 改了,但 Terraform 的 state 不知道,导致"应该是什么样"跟"实际是什么样"不一致。企业里常见的做法是把 CFN 遗留资源逐步 `terraform import` 迁移到 Terraform,统一成一套"账本"。

## 6. S3 + CloudFront 静态站点架构(替代容器托管)

适用场景:纯前端 SPA(无服务端渲染),典型如 Vue/React Router 的 history 模式路由。

- **架构**:CloudFront(CDN + 缓存)→ OAC(Origin Access Control,限制只有 CloudFront 能访问)→ S3(存放编译后的静态文件)。**没有 ALB,没有容器/EC2**。
- **SPA 路由的坑(高频考点)**:Vue Router / React Router 的 history 模式下,`/app/patients/123` 这类深链接路由只存在于客户端,S3 不认识这个 key。
  - OAC 私有源站下,访问不存在的 key,S3 返回 **403 Forbidden**(不是 404,因为桶策略禁止路径枚举,ListBucket 权限也没给)。
  - **`404` 只有在授予了 `ListBucket` 权限时才会出现**,OAC-only 配置不包含这个权限。
  - 所以 **CloudFront 的 Custom Error Response 必须同时映射 403 和 404 → `index.html`(HTTP 200)**,只映射 404 会导致直接访问深链接/刷新页面直接挂掉。
- **为什么这个架构更省钱**:
  1. 没有"always-on 计算资源"——容器/EC2 24小时挂着就要付钱,S3 只按存储量+请求数付费。
  2. CloudFront 有**账号级**(不是按 distribution)永久免费额度:1TB/月数据传输 + 1000万次/月 HTTP(S)请求。
  3. 没有 ALB,省掉固定小时费 + LCU 费。
- **成本对比要注意的陷阱**:如果原来的容器托管前面挂着一个**共享 ALB**(服务了别的、跟这次迁移无关的东西),那 ALB 的成本不能算作"迁移能省下来的钱",只有专属于被迁移服务的计算资源(Fargate/EC2 部分)才能干净地归因为节省。

## 7. 实战排查方法论(交叉验证)

**交叉验证(Cross-validation)**:从两个互相独立、不同来源的地方查到同一个数字,如果吻合,大幅提高这个数字"是真的"的可信度(两边同时凑巧错成一样的概率极低)。

案例:
- 来源 A:ECS Console → Cluster → Tasks 标签 → 2 running task
- 来源 B:EC2 Console → ALB → Target Group → 2 targets

两个完全不同的服务界面给出一致的数字 → 可信。

**排查顺序建议**(从"配置声明的"到"实际运行的"):
1. 先看 IaC 源码(CFN/Terraform)——了解设计意图,但**不能全信**,可能有 drift。
2. 去对应的 Console 页面(ECS Service/Tasks、ALB Resource map)看**实时状态**。
3. 有条件时用 Cost Explorer 查**真实账单**,比套用公式估算准确得多。
4. 遇到"这个资源是不是共享的"这类疑问,别只看单个 Service 关联了什么,要去资源本身(如 ALB)的全局视图(Resource map / Listeners and rules)看全部关联关系。
