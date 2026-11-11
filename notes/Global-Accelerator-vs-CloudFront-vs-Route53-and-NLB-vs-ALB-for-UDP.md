# Global Accelerator vs CloudFront vs Route 53 & NLB vs ALB(UDP / VoIP 题)

背景:一道经典 SAA 题——VoIP 业务基于 **UDP**,需要**低延迟路由**和**跨区域自动故障转移**,正确答案是 A(Global Accelerator + 各区域 NLB)。这道题的本质是"按协议 + 故障转移速度选服务"。

---

## 一、题目考点

| 需求 | 对应判断 |
|------|---------|
| 业务协议是 **UDP** | 排除只支持 HTTP/HTTPS 的服务(ALB、CloudFront) |
| **低延迟**接入 | Anycast IP + AWS 全球骨干网 → Global Accelerator |
| **跨区域自动故障转移**,越快越好 | 不依赖 DNS 缓存 → Global Accelerator 优于 Route 53 |

答案组合:**Global Accelerator(入口)+ 每个区域一个 NLB(第 4 层负载均衡)**。

---

## 二、NLB vs ALB:协议支持

| | NLB(Network Load Balancer) | ALB(Application Load Balancer) |
|---|---|---|
| OSI 层 | 第 4 层(传输层) | 第 7 层(应用层) |
| 支持协议 | **TCP、UDP、TCP_UDP**、TLS | HTTP、HTTPS、gRPC(含 WebSocket) |
| 纯 UDP | ✅ 支持 | ❌ 不支持 |
| 典型用途 | VoIP、游戏、IoT、超高吞吐/低延迟、需固定 IP | 按路径/域名路由的 Web 应用 |

→ 题目里只要出现 **UDP**,ALB 直接出局(选项 B、D 排除)。

---

## 三、Global Accelerator(GA)是什么

- 提供 **2 个静态 Anycast IP**,作为全球统一的单点入口
- 用户流量先进入离自己最近的 **AWS 边缘节点**,再走 **AWS 全球专用骨干网**到达目标区域(比走公网互联网更稳、延迟更低)
- 支持 **TCP 和 UDP**
- 对各区域的 Endpoint(NLB / ALB / EC2 / Elastic IP)做**健康检查**;某区域故障时,**数秒内**把流量切到下一个健康且延迟最低的区域
- 因为客户端始终连同一组静态 IP,**不依赖 DNS 解析结果,没有 DNS TTL 缓存问题**

### 类比:机场"全球统一接机口"

- 没有 GA:乘客(用户)自己查各城市分店地址(DNS 解析出的 IP),某家分店关门了,乘客手里的旧地址还指向它,要等地址簿更新(TTL 过期)才知道
- 有 GA:乘客只记一个"全球总接待电话"(Anycast IP)。总台实时知道每家分店是否营业,分店出问题就**当场转接**到别家,乘客完全无感

---

## 四、为什么排除 CloudFront 和 Route 53

| 选项 | 排除原因 |
|------|---------|
| **CloudFront** | 是 CDN,只支持 **HTTP/HTTPS**,无法代理 UDP 流量 |
| **Route 53** | 靠 **DNS 解析**做故障转移,受 **TTL 缓存**影响(客户端/递归 DNS 可能继续用旧 IP),故障切换不如 Anycast 即时、稳定 |

---

## 五、Global Accelerator vs CloudFront vs Route 53 速查表

| 维度 | Global Accelerator | CloudFront | Route 53 |
|------|-------------------|-----------|----------|
| 工作层 | 第 4 层(TCP/UDP) | 第 7 层(HTTP/HTTPS) | DNS |
| 支持 UDP | ✅ | ❌ | (只做解析,不转发流量) |
| 是否缓存内容 | ❌ | ✅(静态/动态内容缓存) | ❌ |
| 入口 IP | 2 个静态 Anycast IP | 随边缘节点,通过域名访问 | 解析出的各区域 IP |
| 故障转移速度 | **数秒**,不受 DNS TTL 影响 | 依赖源站 Origin Failover | 受 **DNS TTL 缓存**影响,较慢 |
| 典型场景 | 游戏、VoIP、IoT、需固定 IP 的全球应用 | 网站/视频/静态资源加速 | 域名解析、加权/延迟/故障转移路由 |

---

## 六、考试速记

> - 题干 **UDP / VoIP / 游戏 / 非 HTTP 协议** → **NLB**(不是 ALB)
> - **全球用户 + 低延迟 + 快速跨区域故障转移 + 非 HTTP** → **Global Accelerator**
> - **HTTP/HTTPS 内容缓存加速** → CloudFront
> - **只是按域名/策略做解析与切换,能接受 DNS 缓存延迟** → Route 53
> - GA 和 CloudFront 的区别一句话:**GA 加速"连接"(任意 TCP/UDP,不缓存),CloudFront 加速"内容"(HTTP,缓存)**

---

## 相关笔记

- ALB 的定位与 7 层能力:[ALB-vs-API-Gateway-vs-Bastion-Host.md](./ALB-vs-API-Gateway-vs-Bastion-Host.md)
- 私网内访问 AWS 服务的网络路径:[VPC-Endpoint-Gateway-vs-Interface-vs-NAT-Gateway.md](./VPC-Endpoint-Gateway-vs-Interface-vs-NAT-Gateway.md)
