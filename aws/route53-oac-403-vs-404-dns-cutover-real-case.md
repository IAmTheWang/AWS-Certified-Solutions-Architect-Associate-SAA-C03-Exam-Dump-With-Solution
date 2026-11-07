# Route53 DNS 切换 / S3+OAC 403 vs 404 实战笔记(基于 welby-lp-web 真实排查)

来源:在公司项目 `welby-lp-web`(静态 LP 托管仓库)排查 `karte-develop.welby.jp` 访问不了、`ltfu-p-cdn-stg.welby.jp` 报 403 这两个真实问题时,用 AWS CLI(只读)实查出来的结论。比刷题记概念更容易记住,建议对照 SAA 考点复习。

---

## 1. 名词:LP 是什么

**LP = Landing Page(着陆页/落地页)**。日本互联网行业习惯直接说英文缩写 "LP",指**独立的、单页/少页的宣传或功能介绍网站**,不是完整产品站,通常是为某个营销活动、某个功能通知专门做的静态页面。

`welby-lp-web` 这个仓库里,`www`(官网)、`thylog`、`dda`、`ltfu-p-cdn`、`karte-migration` 都是一个个独立 LP——纯 HTML/CSS/JS,没有后端逻辑,做完直接扔到 S3+CloudFront 上就能访问。

## 2. S3 里的 "key" 是什么

S3 不是"文件夹套文件夹"的传统文件系统,本质是**扁平的键值对存储**。你存文件时给的完整路径字符串(比如 `web/index.html`、`web/top.html`)就叫 **key**,概念上等价于"文件路径/文件名",但 S3 内部并没有真正的"目录"这个东西,只是路径字符串里带斜杠、看起来像目录而已。

## 3. `s3:GetObject` vs `s3:ListBucket` —— 决定了报错是 403 还是 404

这个仓库所有 LP 的桶策略(`_deploy/cloudformation/s3.yml`)都只授权了一条:

```json
{
  "Effect": "Allow",
  "Principal": {"Service": "cloudfront.amazonaws.com"},
  "Action": "s3:GetObject",
  "Resource": "arn:aws:s3:::<bucket>/web/*",
  "Condition": {"StringEquals": {"AWS:SourceArn": "arn:aws:cloudfront::<account>:distribution/<distribution-id>"}}
}
```

**没有任何一个桶给了 `s3:ListBucket`。** 这一个权限的有无,直接决定了"文件不存在"时报什么错:

| 场景 | 报错 | 含义 |
|---|---|---|
| 有 `s3:ListBucket` 权限 | **404 `NoSuchKey`** | S3 认为"反正你能翻目录看到有哪些文件,告诉你'这个文件不存在'不算泄露秘密" |
| 没有 `s3:ListBucket` 权限(这个仓库全是这种) | **403 `AccessDenied`** | S3 不会告诉你到底是"没权限"还是"压根不存在"——**统一装死回 403**,防止有人靠枚举文件名 + 观察返回码去猜桶里有哪些私密文件 |

**S3 的判断顺序是:先看你有没有权限,再看东西存不存在。** 没有 `ListBucket` 权限的请求者,连"能不能看目录"都没被允许,所以 S3 更不会告诉它"这个具体文件到底存不存在"。

**连带影响(容易被忽略的坑)**:`lp.yml` 里给单 origin 模式配的 `CustomErrorResponses`(404 → 200 返回 `index.html`,做 SPA 式路径重写)**在这个仓库里其实是摆设**——因为 S3 从来不会真的吐 404 给 CloudFront(永远是 403),这条规则永远不会被触发。只有额外授予 `ListBucket`,404→200 的重写才会真正生效。

**为什么不干脆加上 `ListBucket`**:一旦给了,CloudFront 这个身份就能枚举出桶里**全部**文件名(相当于公开了 `ls` 权限),包括没链接过的历史备份文件(这个仓库里就有 `bk_20250519_index.html`、`index.html.20230822` 这类)。少给这一个权限,是 AWS 用 OAC 时的标准最小权限设计,用"403 掩盖 404,调试麻烦一点"换"不泄露文件列表"。

### 403 vs 404 vs 401 速记
- **401 Unauthorized** = "你还没登录/没提供凭证"
- **403 Forbidden** = "服务器理解了你的请求,但拒绝执行"——**不解释具体原因**,可能是真没权限,也可能是故意不承认资源存不存在
- **404 Not Found** = "这个资源确实不存在",服务器愿意告诉你实话

## 4. OAC(Origin Access Control)—— 比喻

想象一栋**只对内部员工开放、外人一律不让进的大楼**(= 私有 S3 桶,`PublicAccessBlockConfiguration` 全部开启):

- 大楼门口有个**总前台**(= CloudFront),负责接待所有访客、转达请求。
- 但总前台本身**不是**大楼员工,默认情况下前台也进不去楼里的档案室。
- **OAC 就是给总前台发的一张"专属工牌"**,工牌上印着这个前台的**工号**(= CloudFront distribution ID,比如 `EU8BCDHEOOBTT`)。
- 档案室(S3 桶)的门禁规则写死:"只有刷**这个工号**工牌的人能进,别的工号、别的人一概不放行"(= 桶策略里的 `Condition: AWS:SourceArn`)。

效果:
- 用户走正门(= 访问 `xxx.welby.jp`,经过 CloudFront)→ 前台亮工牌 → 门禁认得工号 → 放行。
- 有人想绕过前台、直接摸到 S3 的裸域名硬访问(= 直接拿 S3 域名或走错的 distribution 访问)→ 没工牌/工号对不上 → 门禁拒绝(= `AccessDenied`)。

**一句话**:OAC = 让 S3 桶对全世界关门,但单独给某一个具体的 CloudFront distribution 开一道认得出身份的小门。它是新版方案,旧版叫 **OAI**(Origin Access Identity)。

### "distribution" 是什么、为什么 `SourceArn` 要精确到某一个 ID
一个 AWS 账号下可以有**很多个** CloudFront distribution(这个仓库光 dev/stg/prd 就有一堆:`karte-migration-dev`、`karte-migration-stg`、`karte-migration-prd`、`karte-dev`、`ltfu-p-cdn-stg`……)。每个 distribution 都有独立 ID(如 `EU8BCDHEOOBTT`)和独立域名(如 `d2f30y5o6890pa.cloudfront.net`)。

如果桶策略只写 `Principal: cloudfront.amazonaws.com`、不写 `SourceArn` 条件,等于"只要是 CloudFront 服务发的请求都放行"——账号里随便哪个 distribution 都可能读到这个私有桶。加上 `SourceArn` 条件,才是把信任范围收紧到"只信任这一个具体实例",而不是"信任整个 CloudFront 服务"。

### OAC 和 SigV4 的关系 —— "功能" vs "底层技术",不是两个要分别配置的东西

容易被误解成"OAC 和 SigV4 是两个独立机制,都要自己配"——**不是**。准确的层级关系是:

```text
你配置 OAC
     ↓
OAC 让 CloudFront 用 SigV4 给请求签名
     ↓
S3 验证这个签名,通过就放行
```

接着第 4 节"工牌"的比喻往下延伸:
- **OAC = 门禁规则**:"只有 CloudFront 能进"(你自己配置、能看得见的那一层)。
- **SigV4 = 工牌本身的防伪技术/身份证明**:"证明你确实是 CloudFront,不是冒充的"(OAC 背后自动使用的底层签名机制,AWS 帮你实现好了,你不需要、也不能自己手动去实现 SigV4 签名逻辑)。

**作为 AWS 使用者,实际要做的操作只有三步**:创建 OAC → 关联到 CloudFront distribution → 改 S3 桶策略允许这个 OAC/distribution。SigV4 是"OAC 怎么做到安全验证"的底层原理,不是你需要额外去开通、配置的一个独立 AWS 产品。

**SAA 考试速记**:看到题目描述 "CloudFront needs secure access to a private S3 bucket" 这种场景,脑内直接反应成:

```text
Private S3
    ↑
    │ SigV4(底层签名机制,自动生效)
CloudFront
    ↑
    │
   OAC(你实际配置的东西)
```

甚至可以再简化成一句话记:**`OAC → CloudFront securely accesses private S3`**——SigV4 只是用来理解"OAC 到底是怎么做到安全验证的"这一层原理,考试选项里如果出现"需要额外单独配置 SigV4"这种说法,基本可以判断是干扰项。

## 5. CloudFormation "Stack" 怎么理解

AWS 官方中文文档译作「**堆栈**」,但容易和数据结构的"栈(LIFO)"搞混。按语境理解成:

> **"一组被打包成一个整体、统一创建/更新/删除的 AWS 资源集合"**,口语化说成「这套资源」/「这个部署单元」更不容易误解。

**跟日本同事沟通时,直接保留原词 `stack` / スタック就好,不用刻意翻译**——工程师和团队 lead 日常都是直接说 "Stack",翻译成中文/日文反而更绕。

对应到 `welby-lp-web`:每次 `make deploy host=xxx stage=xxx` 会生成两个这样的资源集合——`lp.yml` 那份(CloudFront + WAF + Route53 记录),和 `s3.yml` 那份(S3 桶 + 桶策略)。

## 6. Route53 A(ALIAS) 记录 —— DNS 切换的实际操作对象

真实案例:`karte-develop.welby.jp` 访问不到新内容,查下来是 **DNS 根本没切过来**,不是 CloudFront/S3 配置问题:

| 项 | 现状 | 需要改成 |
|---|---|---|
| Route53 记录类型 | A(ALIAS) | A(ALIAS)(类型不变) |
| 目标 | 旧 legacy ALB:`dualstack.welby-new-karte-dev-alb-xxx.ap-northeast-1.elb.amazonaws.com`(HostedZoneId `Z14GRHDCWA56QT`) | 新 CloudFront distribution:`d2jfnaurbw6cb8.cloudfront.net`(HostedZoneId `Z2FDTNDATAQYW2`,**所有** CloudFront 的 ALIAS 目标固定用这个 HostedZoneId) |

**排查方法(只读,不改资源)**:
```bash
aws route53 list-resource-record-sets --hosted-zone-id <zone-id> \
  --query "ResourceRecordSets[?Name=='<host>.welby.jp.']"
```

**关键概念:CloudFormation 的 `CreateDnsRecord` 参数**——如果某个 stack 部署时传了 `CreateDnsRecord=false`,代表这个 stack **故意不托管** Route53 记录,DNS 记录的增删改完全在 CloudFormation 管辖之外,可以单独手动改,不会和 IaC 打架。反过来,如果 `CreateDnsRecord=true`,Route53 记录由 `AWS::Route53::RecordSet` 资源管理,手动改了容易在下次 `deploy`/`delete` 时产生 drift 或冲突。

## 7. 切 DNS 前还要检查什么(容易漏掉、导致"切完了但还是打不开")

DNS 只是**必要条件之一**,不是充分条件。同一个 CloudFront distribution 的部署参数里,常常还挂着:

- **Basic Auth**(`BasicAuth=enabled` / `BasicAuthRealm`):切完 DNS 浏览器会弹账号密码框。
- **WAF `ip-restricted` 模式**(`WAFMode=ip-restricted` + `AllowedIPv4`/`AllowedIPv6`):访问者的公网 IP 不在白名单里,会被 WAF 拦截,报 **403**——这个 403 和第 3 节讲的"S3 缺 ListBucket 导致的 403"**看起来一样,但原因完全不同**(一个是 CDN 边缘层的 IP 准入拦截,一个是源站权限设计),排查时不能只看状态码,要去确认到底是哪一层挡的(CloudFront/WAF 日志 vs S3 直接报错)。

**经验教训**:切换生产/共享 DNS 之前,把这些"切完之后可能造成误解的连带影响"提前写清楚讲给相关人(比如 team lead),比切完之后再解释"为什么弹密码框/为什么还是 403"要高效得多——对方第一反应通常是怀疑"是不是 DNS 切错了",提前说明能省掉一轮不必要的排查。

## 8. 实战排查方法论(交叉验证)

**排查顺序建议**(从"配置声明的"到"实际生效的"):
1. 先看仓库里的 IaC 源码(`Makefile` / CloudFormation 模板)——了解设计意图和参数命名规则,但**不能全信**,实际部署时的参数可能跟仓库当前 HEAD 的默认值不一样。
2. 用 `aws cloudformation describe-stacks --query "Stacks[0].Parameters"` 查**某次实际部署时真正传入的参数**(比如 `HostName`/`Suffix`/`CreateDnsRecord` 这些决定行为的关键值),不要只靠猜测或文档描述去反推。
3. 用 `aws route53 list-resource-record-sets` / `aws cloudfront get-distribution(-config)` / `aws s3 ls` 逐层确认**DNS → CDN → 源站**每一层的真实状态,而不是假设"某一层配对了,别的层也一定对"。
4. 多个独立来源(CloudFormation 参数 / Route53 记录 / S3 桶实际文件列表)查到的结论互相吻合 → 可信度大幅提高。
