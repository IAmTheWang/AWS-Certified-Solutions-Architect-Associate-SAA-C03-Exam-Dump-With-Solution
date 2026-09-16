# VPC Endpoint（Gateway/Interface）与 NAT Gateway 网络层笔记

## 一、题目场景：EC2 访问 S3 API，要求流量绝不能走公网

VPC 内的 EC2 应用需要调用 S3 API 存取对象，公司安全规定：应用流量不允许经过互联网。

### 正确答案：配置 S3 Gateway Endpoint
Gateway Endpoint 是一种 VPC Endpoint，提供从 VPC 到 S3 的**直接私有路由**，完全走在 AWS 内部网络里，不经过公网。实现方式是往路由表里加一条规则："目标 IP 落在 S3 官方公布的 IP 段（prefix list）里时，走 Gateway Endpoint，不走 NAT/Internet Gateway"。哪怕 EC2 实例完全没有访问公网的能力（私有子网、无 NAT），也能通过 Gateway Endpoint 正常调用 S3 API。而且 **Gateway Endpoint 是免费的**（不收小时费，不收数据处理费），是本题最佳实践方案。

### 为什么不是 NAT Gateway
NAT Gateway 的存在意义就是"让私有子网的实例能够访问公网"——用 NAT Gateway 访问 S3，流量恰恰要先经过 Internet Gateway、走公网上的 S3 endpoint，这跟题目"不允许经过互联网"的要求完全相反，是本题最大的陷阱（方向搞反）。

### 为什么不是"S3 bucket 建在私有子网"
技术上不成立。**S3 不是 VPC 内的资源**，S3 bucket 没有 ENI（虚拟网卡），无法被"放进"某个子网。S3 是脱离 VPC 网络体系、Region 级的全局命名空间服务，这个选项本身在架构上就说不通，属于纯干扰项。

### 为什么不是"S3 bucket 建在跟 EC2 相同 Region"
同 Region 只是为了降低延迟、避免跨区域数据传输费用，**跟网络路径要不要走公网完全无关**。默认情况下即使同 Region，访问 S3 走的也是公网 endpoint（`s3.region.amazonaws.com`），除非专门配置 VPC Endpoint，否则流量该走公网还是走公网。

## 二、Gateway Endpoint vs Interface Endpoint (PrivateLink)

VPC Endpoint 分两种，SAA 常考区分：

| | Gateway Endpoint | Interface Endpoint (PrivateLink) |
|---|---|---|
| 支持的服务 | 只有 **S3、DynamoDB** 两个 | 几乎所有其他 AWS 服务（SQS、SNS、KMS、Secrets Manager 等），也支持第三方 SaaS |
| 实现方式 | 改路由表，匹配服务的 IP 前缀列表(prefix list) | 在你的子网里创建真正的 **ENI**（私有 IP），通过 AWS 内部 Network Load Balancer 转发到目标服务 |
| 费用 | **免费** | 收费：按小时 + 按处理的数据量(GB) |
| 是否占用网络资源 | 不占用，不需要额外虚拟设备 | 占用 ENI/IP，通常每个可用区(AZ)建一个，有 ENI 数量上限 |
| 吞吐瓶颈 | 无额外瓶颈（走 AWS 骨干网路由） | 受限于 ENI 本身的网络带宽上限 |

**SAA 做题判断口诀**：题目要求"私有子网访问 S3/DynamoDB，不能走公网" → Gateway Endpoint；要求"访问其他 AWS 服务（SQS/SNS/Secrets Manager 等），不能走公网" → Interface Endpoint (PrivateLink)。PrivateLink 是 SAA 高频考点。

### 为什么只有 S3/DynamoDB 用 Gateway Endpoint，其他服务不行
不是"技术上做不到"，是历史+架构权衡的结果：
- S3（2006）、DynamoDB（2012）是最早、使用量最大的两个 AWS 基础服务，且是 **Region 级公共共享服务**——所有客户共用同一批相对稳定、可以被整理成 prefix list 的 AWS 官方 IP 段，天然适合"路由表匹配 IP 段"这种轻量方案。
- 与之相对，像 RDS 这类"每个客户实例拥有自己独立、动态分配地址"的资源，压根没法整理出一份"所有可能地址"的清单，从架构上就不适合走 Gateway Endpoint 这条路。
- AWS 后来（约2017年前后）发明了更通用的 **PrivateLink**：直接在你的子网建 ENI，不需要预先知道对方服务用了哪些 IP，因此能覆盖几乎任意服务。但 S3/DynamoDB 已经用免费的 Gateway Endpoint 方案解决得很好，没必要"升级"成收费的 PrivateLink，所以现状固定成了两套并存的方案。

### "IP 前缀匹配"不是 Gateway Endpoint 特有的麻烦机制
容易被误解为"专门为 S3 设计的复杂方案"，但其实**所有网络路由的底层原理，从互联网诞生起就是"匹配目标 IP 落在哪个网段(CIDR)"**（最长前缀匹配，longest prefix match）——任何一台服务器的路由表本来就写满了这种规则（比如 `10.0.0.0/16 → 本地网络`，`0.0.0.0/0 → 默认网关`）。Gateway Endpoint 只是往路由表里多加几行"匹配 S3 官方 IP 段"的规则，对路由器而言毫无额外负担。反而是 **PrivateLink 更"重"**——要真正创建 ENI、走 NLB 转发、处理 DNS 解析变更，这些才是额外的基础设施成本，这也是为什么 Gateway Endpoint 能免费、PrivateLink 要收费的原因。

### PrivateLink 具体怎么运作（不是"用唯一 ID 做 socket link"）
更准确的理解：PrivateLink 在你指定的子网里创建一个 ENI（私有 IP），背后通过 AWS 托管的 Network Load Balancer 连到目标服务的后端集群。你的应用请求目标服务的域名时，DNS 解析出来的地址变成这个 **ENI 的私有 IP**（而不是公网 IP），于是请求走的是"发到我 VPC 内部这个私有地址"，自然全程留在 AWS 内网，不出公网。本质仍是标准的 IP 网络通信，只是这个 IP 恰好是你自己 VPC 私有网段里的地址。

### 什么情况下要专门配置 Gateway Endpoint
1. 私有子网实例要访问 S3/DynamoDB，且完全不允许出公网（合规/安全要求）
2. 即使子网本来就有 NAT Gateway（允许访问其他外网服务），访问 S3/DynamoDB 若走 NAT Gateway 会产生按 GB 计费的数据处理费；配置 Gateway Endpoint 后这部分流量改走免费路径，**单纯为了省钱**也常配置
3. 想用 Endpoint Policy + bucket policy 的 `aws:sourceVpce` 条件，限制"只有来自这个特定 VPC 的流量才能访问该 bucket"，做纵深防御

## 三、NAT Gateway 是什么、成本考量、与堡垒机的区别

### NAT Gateway 的作用
让**私有子网**里、没有公网 IP 的实例，能够**主动访问外网**（下载软件更新、调用外部第三方 API），同时不需要给这台实例暴露公网 IP。机制：私有实例的出站请求先经路由表导向 NAT Gateway，NAT Gateway 用自己的公网 IP（通常是一个 EIP）代为访问外网，响应再原路转发回来。**只支持出站(outbound-only)**，外部无法通过 NAT Gateway 主动连进私有实例。

### NAT Gateway 不一定比给实例配公网 IP 便宜
容易有的误解是"用 NAT Gateway 更省钱"，但实际上：
- NAT Gateway 收费 = 每小时固定费 + **按处理的数据量(GB)收费**，大流量场景这笔费用会迅速堆积，可能比直接给实例配 EIP 更贵（EIP 绑定在运行中的实例上通常免费或很便宜，Internet Gateway 本身不收数据处理费）
- 选 NAT Gateway 的**真正原因是安全，不是省钱**：私有实例完全不暴露公网 IP，外部无法直接扫描/攻击，且所有出网流量集中经过一个出口，便于统一做日志审计和流量控制。这笔"安全成本"通常被认为值得付，但不代表它是更便宜的选项。
- 实际生产中常见的成本优化思路：尽量把能走 Gateway Endpoint（S3/DynamoDB，免费）的流量分流出去，减少经过 NAT Gateway、按 GB 计费的数据量。

### NAT Gateway ≠ 堡垒机（Bastion Host），方向相反
两者都是"单一出入口、集中管控"的安全设计思路，但流量方向完全相反，不能划等号：

| | NAT Gateway | Bastion Host（堡垒机，详见 [[ALB-vs-API-Gateway-vs-Bastion-Host]]） |
|---|---|---|
| 流量方向 | 私有子网 → 外网（出站） | 外部人员 → 私有子网实例（入站） |
| 谁发起连接 | 私有实例自己主动访问外部资源 | 运维人员从外部主动登录私有服务器（SSH/RDP） |
| 解决的问题 | 私有实例怎么访问外网 | 人怎么从外网安全登录到私有实例做运维 |

堡垒机日语叫 **踏み台サーバー**（ふみだいサーバー）或音译 **バスティオンホスト**；英语就是 **Bastion Host**（也叫 jump box/jump server）。

## 四、ENI 与 MAC 地址（辅助网络概念）

### ENI（Elastic Network Interface，弹性网络接口）
可以理解成 EC2 实例的"虚拟网卡"，挂在某个 VPC 子网里，有自己的私有 IP（可选公网 IP）、安全组规则、MAC 地址等属性。一台 EC2 至少有一个 ENI，也可以挂载额外 ENI 做多网卡场景。ENI 从一个实例分离(detach)、挂到另一个实例(attach)时，MAC 地址保持不变，因为地址是跟着这个"虚拟网卡对象"走，不是跟着某台物理机器走。S3 之所以不能"放进私有子网"，正是因为 S3 这类服务没有 ENI 这个概念，完全在 VPC 网络体系之外。

### MAC 地址
网络硬件设备的出厂唯一编号，由网卡厂商烧录在网卡固件里。台式机如果是主板集成网卡（onboard NIC），MAC 地址确实随主板走；如果是插独立网卡（PCIe/USB 网卡），MAC 地址跟着这张网卡走、与主板无关。操作系统层面也支持软件伪装(spoof)一个临时 MAC 地址，重启或改回设置后恢复，属于"烧录值"与"操作系统上报值"两个不同层次的东西。

## 五、三者的"小区"比喻总结（更直观的版本）

把服务器想象成住在一个**高安全封闭小区**（VPC 私有子网）里，默认与外界完全隔绝。三个组件是"小区如何与外界交互"的三种不同通道：

- **NAT Gateway = 单向出口海关 / 只出不进的快递门卫**：居民（服务器）要上网下载更新、访问外部 API，通过门卫去**公网大马路**上把数据拿回来；外面的陌生人想反过来穿过这扇门进小区，会被门卫死死拦住。特点：走公网、通用性强（能访问任何公网 IP）、按时长和流量收过路费。

- **Gateway Endpoint = 隔壁水厂的专用免费后门**：物业直接在后墙凿开一扇**专用免费直通门**，直达隔壁的公共自来水厂（仅限 S3、DynamoDB）。特点：完全不走公网大马路、速度快；只支持这两个特定服务；完全免费。

- **PrivateLink / Interface Endpoint = 拉进你家客厅的专属服务接线盒**：服务提供商（AWS 其他服务、第三方 SaaS、公司其他部门）直接在你家客厅墙上装一个**内网接线盒**（分配一个小区内部 IP）。访问他们的服务就像访问隔壁房间，连小区大门都不用出。特点：利用 AWS 骨干网直连，支持极丰富的服务生态；按小时和流量收服务费。

### 三者对比表

| 维度 | NAT Gateway | Gateway Endpoint | PrivateLink (Interface Endpoint) |
|---|---|---|---|
| 形象比喻 | 公共单向出入口门卫 | 隔壁水厂的免费专用后门 | 室内延伸安装的专属接线盒 |
| 访问目标 | 整个互联网 | 仅限 S3、DynamoDB | AWS 绝大多数服务、第三方 SaaS、自研 VPC 服务 |
| 流量路径 | 经过公网（绑定 Elastic IP） | 完全留在 AWS 内网 | 完全留在 AWS 内网 |
| 实现机制 | 路由表下一跳指向 NAT 节点 | 路由表添加 Prefix List 拦截 | 在你的子网中生成一个私网网卡(ENI) |
| 费用 | 较贵（按小时+流量费） | 完全免费 | 适中（按小时+流量费） |

### 协同关系（不是互斥，是各司其职）
1. **避坑省钱**：私有服务器既要上网、又要向 S3 传输海量日志时，别让 S3 流量走 NAT Gateway（产生昂贵流量费）——配 Gateway Endpoint 让 S3 流量免费走后门，其余公网流量才走 NAT Gateway。
2. **跨界安全**：要调用第三方供应商 API 或公司另一个 VPC 的微服务，既不想走公网（排除 NAT Gateway），对方也不是 S3（排除 Gateway Endpoint）——此时 PrivateLink 是唯一最佳方案，把对方服务映射成本地 VPC 的一个私网 IP。

### 成本量化（以 us-east-1 定价为例）

| 组件 | 单 AZ 基础月费 | 1 TB 流量处理费 | 成本层级 |
|---|---|---|---|
| Gateway Endpoint | $0 | $0 | 零成本 |
| PrivateLink（单 AZ） | ~$7.20 | ~$10.24（$0.01/GB） | 中低成本 |
| NAT Gateway（单网关） | ~$32.40 | ~$46.08（$0.045/GB） | 高成本 |

NAT Gateway 的小时费和按 GB 流量费都约是 PrivateLink 的 **4.5 倍**；若再算上 NAT Gateway 传出到 Internet 的公网数据传输费，实际账单差距会进一步放大——"NAT Gateway 是三者中最贵的"这个结论在量化上成立。

## 六、如果对方不在 AWS 上，怎么私有连接

**前提**：PrivateLink 要求服务提供方把服务挂载在 AWS 的 Network Load Balancer (NLB) 上再映射到你的 VPC——所以**双方都必须有 AWS 资源**才能用 PrivateLink。Datadog、Snowflake、MongoDB Atlas 这类第三方 SaaS 能提供 PrivateLink 接入，是因为它们自己把服务部署在了 AWS 的 VPC 里；如果对方完全没有 AWS 资源（自建机房、阿里云、腾讯云、Azure），就无法直接创建 PrivateLink。

这种情况下，按"能不能接受走公网"分两条路：

**方案 A：走公网（对方提供公网 API/域名）**
- **NAT Gateway**：最标准方案。私有服务器通过 NAT Gateway 访问对方的公网 IP/域名，单向发起请求，外部无法主动扫描你的服务器。如果对方只是暴露一个公网 HTTPS 接口，这是最省事的方案。

**方案 B：走私网/专线直连（对方是本地机房或其它云，且严禁走公网）**
- **AWS Site-to-Site VPN**：在 AWS VPC 与对方防火墙/路由器之间建立基于 IPsec 的加密隧道。底层物理数据仍经过互联网，但传输内容全程加密，业务感知上如同内网互通。
- **AWS Direct Connect (DX)**：拉一条物理光纤，把 AWS 接入点与对方本地数据中心直连，完全绕开互联网，安全性最高、延迟最低。
- **多云专线（Megaport / Equinix 等第三方专线商）**：对方在 Azure/GCP 时，通过第三方专线服务商打通 AWS VPC 与对方云平台的虚拟网络。

企业级机房对打、严禁流量经过公网 → 优先 VPN 或 Direct Connect；对方只是个公网接口 → NAT Gateway 最省事。

## 七、Site-to-Site VPN vs HTTPS；Internet vs WWW

### Site-to-Site VPN 不等于"AWS 提供的 HTTPS"
两者在"用加密保证安全"这个初衷上相似，但**作用范围和层级完全不同**：

- **HTTPS（应用层，点对点）**：像两个人身处公共广场，身边都是陌生人，但用只有彼此懂的"暗号"说话——只加密单一的网页/API 请求（比如浏览器访问某个 URL），管不到服务器上的其他流量。
- **Site-to-Site VPN（网络层，网对网）**：像在公共大马路地下，挖一条连接两个小区（AWS VPC 和公司本地机房）的专属地下暗道。连接的是**两个完整的网络环境**——暗道一旦通了，机房里几百台电脑和 AWS 上几百台服务器就像在同一个房间里，不仅能发 HTTP 请求，还能直接 SSH 远程登录、数据库内网直连、文件共享，管道里所有流量全部自动加密，不需要每个应用自己单独做 HTTPS。

### 公网 = 全球最大的公共平台传输数据（这个理解是对的）
- **Internet（互联网）**：全球无数路由器、光纤串联起来的"公共公路网"本身（基础设施），任何人接上网线就能在这个平台上互送数据包。
- **WWW（万维网）**：只是跑在这条公路网上的**某一种特定服务**（网页服务），不等于 Internet 本身。
- 不管是 NAT Gateway 访问外部接口，还是 Site-to-Site VPN 在公网上建加密隧道，底层利用的都是 **Internet** 这条全球最大的公共公路网，而不是狭义的 WWW。

## 八、SAA 考频参考
- **Gateway Endpoint（S3/DynamoDB 私有访问）**：高频考点，常见陷阱是拿 NAT Gateway、跨账号权限、同 Region 部署等选项来混淆"流量走不走公网"这个核心考察点。
- **Interface Endpoint / PrivateLink**：高频考点，考察"S3/DynamoDB 用 Gateway，其他服务用 Interface"的区分。
- **NAT Gateway vs Bastion Host**：概念题常考，注意流量方向相反，不要混淆。
- **Site-to-Site VPN / Direct Connect**：中高频考点，常见考法是"企业需要长期、稳定、加密地连接本地机房与 AWS，且不想完全依赖公网" → VPN（快速但仍经公网）或 Direct Connect（专线，更贵更稳、延迟更低），二者常配合使用（DX 做主线、VPN 做备份）。
