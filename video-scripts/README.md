# AWS 人话课：短视频系列稿（每期 3 分钟）

把仓库笔记里的比喻拆成一期一个主题的口播稿。每期一个核心比喻、一个考点结论、一个"别讲错"清单。

## 目录

| 期 | 主题 | 核心比喻 | 口播字数 | 来源笔记 |
|---|---|---|---|---|
| [EP01](EP01-vpc-nat-endpoint-privatelink.md) | NAT / Gateway Endpoint / PrivateLink | 封闭小区的三条通道 | 716 | `notes/VPC-Endpoint-...` |
| [EP02](EP02-alb-vs-api-gateway.md) | ALB vs API Gateway | 收费站 vs 机场安检 | 684 | `notes/ALB-vs-API-Gateway-...` |
| [EP03](EP03-s3-403-vs-404-oac.md) | S3 的 403 vs 404 与 OAC | 只对员工开放的大楼 + 工牌 | 676 | `aws/route53-oac-...` |
| [EP04](EP04-cloudfront-waf-us-east-1.md) | CloudFront / WAF / us-east-1 | 连锁便利店的总部登记处 | 634 | `aws/cfn-template-size-...` |
| [EP05](EP05-ipv6-nat-egress-only-igw.md) | IPv6、NAT、Egress-only IGW | 公司总机 + 单向旋转门 | 621 | `aws/cfn-template-size-...` |
| [EP06](EP06-dns-a-cname-alias.md) | A / CNAME / ALIAS，DNS 层 vs HTTP 层 | 名片、转接牌、前台代办 | 596 | `aws/cfn-template-size-...` |
| [EP07](EP07-cloudformation-ikea-changeset.md) | CloudFormation Stack / Change Set | 宜家说明书 | 614 | `notes/CloudFormation-ChangeSet-...` |
| [EP08](EP08-ci-green-five-days-negative-control.md) | 模板大小上限与 negative control | 信封 vs 储物柜；点烟测报警器 | 700 | `aws/cfn-template-size-...` |
| [EP09](EP09-docker-ecs-ec2-fargate-lambda.md) | Docker / ECS / EC2 / Fargate / Lambda | 餐厅经理与厨师 | 636 | `notes/ECS-vs-Docker-...` |
| [EP10](EP10-rolling-canary-blue-green.md) | 滚动 / 金丝雀 / 蓝绿 | 换轮胎 / 金丝雀 / 盖新楼 | 670 | `notes/ECS-vs-Docker-...` |

建议发布顺序按编号：EP01–03 偏"网络与权限"，EP07–08 偏"CloudFormation 与工程实践"，每期结尾都预告了下一期。

## 每期统一结构

1. **一句话核心** + **贯穿比喻**
2. 按时间轴分段：**画面**（给剪辑的提示）+ **口播**（用 `>` 引用块，直接念）
3. 备选标题 / 封面文案 / 标签
4. **讲之前核对**：哪些数字是粗略估算、哪些是笔记里标了"未核实"的推断、哪些不该上屏

## 时长说明（请先读）

- 口播字数是只数汉字的结果，约 600–720 字。按常见短视频语速（每秒 3.5–4 个汉字，含停顿），一期约 2 分 40 秒到 3 分钟。
- EP05、EP06 偏短（约 600 字），可以靠画面停顿、字幕强调补足；EP01、EP08 最满，录的时候如果超时，优先删"实战"段的最后一句。
- 时间轴是按各段字数自动分配的，录完后请按实际语速微调。

## 发布前必做

- **脱敏**：笔记来自公司真实项目。稿子里已不出现项目名、仓库名、PR 号、账号 ID、桶名、distribution ID，剪辑时也不要让终端截图、控制台画面露出这些信息。
- **价格与数字**：EP01 的价格、EP02 的"几美分 vs 三十多美元"、EP04 的"七百多个边缘节点"都是笔记中的示例或快照，发布前请对照官网，并在画面加"以官网为准"。
- **推断不当事实**：笔记里标了"我的理解，未核实"的内容（如 us-east-1 的设计理由、Lambda@Edge 日志就近写入的原因）已在稿子里刻意不讲，别在口播里补一个听起来合理的解释。

## 待开发选题（笔记里已有素材）

- 内部 ALB 为什么安全组写了 `0.0.0.0/0` 仍然是安全的（纵深防御：Scheme=internal + 私有子网）——`notes/ALB-vs-API-Gateway-vs-Bastion-Host.md` 第十一节；注意该节明确写了"设计原因是推断"。
- TLS 卸载与 ACM 免费证书——同一份笔记第九、十节。
- 堡垒机 vs NAT（方向相反）、Site-to-Site VPN 的"地下暗道" vs HTTPS——`notes/VPC-Endpoint-...` 第三、七节。
- `validate` 与 `_validate`（政府窗口 vs 安检口）、Lambda 的限制（冷启动、15 分钟）——可做 60 秒补充短视频。
- 还没读过、尚未提炼的笔记：Aurora/RDS/DynamoDB、Cognito、ECR、RDS Proxy/ElastiCache、IAM 策略评估、S3-CloudFront 迁移。
