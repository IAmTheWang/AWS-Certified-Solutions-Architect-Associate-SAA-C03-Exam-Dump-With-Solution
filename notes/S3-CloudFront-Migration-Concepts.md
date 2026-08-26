# S3 + CloudFront 迁移设计笔记(容器托管 → 静态托管)

背景:一个 Vue 3 SPA 项目从 ECS Fargate + ALB 容器托管,迁移到 S3 + CloudFront + GitHub Actions 静态托管的设计评审过程中,整理的核心知识点。

---

## 一、为什么 S3+CloudFront 比容器托管省钱

**核心区别不是"谁的技术更好",而是"有没有常驻计算资源"。**

- **容器托管(ECS Fargate)**:不管有没有用户访问,Fargate task 都要 7×24 小时占着 vCPU/内存,按小时计费——这就是"常驻计算资源"。
- **S3+CloudFront**:没有任何进程在运行。用户请求打到 CloudFront 边缘节点,命中缓存直接返回,没命中就去 S3 读一个静态文件返回。全程没有"闲着也要付费"的服务器。

原来用 Fargate 时"访问不到边缘缓存",本质不是 Fargate 的问题,而是**架构里根本没有 CDN 这一层**——用户请求直接打 ALB→ECS,没有边缘节点。理论上也可以在 ALB 前面单独加一层 CloudFront,一样能有边缘缓存,只是对纯静态 SPA 来说,直接用 S3 当 origin 更简单、还不需要常驻计算资源。

---

## 二、静态资源的缓存失效策略:不是"全量失效"

**误区**:以为每次部署都要让 CloudFront 全部缓存失效,不然用户看到旧内容。

**实际做法**利用了现代前端构建工具(Vite/Webpack/Rollup 等)的通用特性——**内容哈希文件名(content hashing)**:

- 构建工具对每个打包产物的**最终内容**算一次哈希,拼进文件名,比如 `main.abc123.js`。
- 内容没变 → 哈希不变 → 文件名不变;内容变了(哪怕一行代码)→ 哈希大概率整个变 → 生成一个全新文件名。
- 这不是"顺带具备"的特性,而是专门为解决"静态资源长期缓存"问题设计的:文件名和内容强绑定,就可以放心把这些文件设成 `Cache-Control: immutable`(永久缓存),因为内容真变了、文件名一定跟着变,不会有"同名字缓存着旧内容"的情况。

于是缓存失效可以分两类处理:

| 类型 | 文件名 | 缓存策略 | 每次部署要不要失效 |
|---|---|---|---|
| JS/CSS 等资源 | 带内容哈希,内容变名字就变 | `immutable`,长期缓存 | 不需要,新版本引用的就是新文件名 |
| `index.html` | 文件名永远不变 | `no-store` | **需要**,每次部署精确失效这一个文件 |

只失效 `index.html` 而不是 `/*`,还有额外好处:AWS 对每月超 1,000 条失效路径收费,只失效一条固定路径,成本不随资源数量增长;失效 `/*` 会把本该继续缓存的哈希资源也清空,下次请求全部要重新回源。

---

## 三、CloudFront 的两个"边角"知识点

### 1. Origin Access Control(OAC)

让 S3 bucket 只允许"这一个 CloudFront distribution"读取,其他任何来源(包括直接拿 S3 URL 访问)一律拒绝。没有 OAC 的话,只要 bucket 公开可读,任何人绕过 CloudFront 直接访问 S3,就能绕开缓存、WAF、安全响应头这些防护。

### 2. viewer TLS 证书为什么必须在 us-east-1

CloudFront 区分两段连接:"viewer 侧"(用户浏览器 ↔ CloudFront 边缘节点)和"origin 侧"(CloudFront ↔ 源站)。viewer TLS 证书就是浏览器和 CloudFront 握手用的证书。**不管源站部署在哪个区域**(比如 ap-northeast-1),CloudFront 作为全球服务,要求这张证书必须托管在 **us-east-1**——这是 AWS 的硬性要求,没有变通办法。

---

## 四、安全响应头:CloudFront Function 的一个已知坑

**场景**:SPA 用 history 模式路由,像 `/xxx/patients/123` 这种深层链接只存在于客户端,S3 不认识。做法是配置 `custom_error_response`,把 403/404 都改写成 `/index.html`(状态改成 200)返回,交给前端路由处理。

**坑**:如果安全响应头(HSTS/CSP/X-Frame-Options/X-Content-Type-Options)是靠挂在 viewer-response 阶段的 **CloudFront Function** 来加,会有一个 AWS 既有限制——走"错误改写"这条路径返回的响应,绑定在该 cache behavior 上的 Function **不会执行**。也就是说所有深层链接命中的 fallback 响应,都会缺这几个安全头。

**修法**:改用 **CloudFront Response Headers Policy**——这是绑定在 distribution/cache behavior 级别的独立机制,不依赖 viewer-response 阶段的 Function 是否执行,不管正常响应还是错误改写后的响应都会被统一打上头。CloudFront Function 只留给 Response Headers Policy 表达不了的逻辑(比如按 URI 分支的 Cache-Control、cookie 清理)。

**验收怎么做**:不是"配置改了就自动等于生效",而是要实际发请求验证——故意访问一个会触发 fallback 改写的深层链接,用 DevTools 或 `curl -I` 看返回头里是不是真带着这几个安全头,眼见为实。

### 安全响应头速查

| 响应头 | 作用 |
|---|---|
| HSTS | 告诉浏览器"以后只准用 https 访问这个域名",防止被降级到明文 |
| CSP(Content Security Policy) | 限制页面只能加载指定来源的脚本/样式/图片,防止 XSS 注入的恶意脚本被执行 |
| X-Frame-Options | 禁止别的网站用 `<iframe>` 嵌入本站,防点击劫持 |
| X-Content-Type-Options: nosniff | 禁止浏览器"猜"文件类型,防止上传的文件被当成脚本执行 |

---

## 五、HTTP → HTTPS 重定向 & HSTS

**为什么要 301 再跳到 443,不能直接落在 443?**

浏览器第一次发起连接时,走的就是明文的 80 端口(用户输入不带协议的域名,或点了老的 `http://` 链接)。连接一旦以明文协议建立在 80 端口上,服务器没法凭空把它切换成加密的 443——协议不匹配。服务器唯一能做的,是在这条 80 端口连接上回一个 **301**,告诉浏览器"这个地址挪到 https:// 去了,重新发一次请求";浏览器收到后**重新发起一条新连接**,这次才连 443、走 TLS。所以 301 跳转是"从明文切换到加密"唯一的握手方式,不是多余步骤。

**HSTS 怎么把这一趟省掉的?**

`Strict-Transport-Security` 响应头本质是服务器给浏览器的一条"记住这件事"的指令(如 `max-age=31536000`)。浏览器收到后,在**本地**记一笔:"接下来这段时间,这个域名只能用 https 访问"。下次不管用户怎么输入,浏览器在**真正发出网络请求之前**,先查本地这份名单,发现命中,就直接在本地把协议改写成 `https://` 再发连接——全程没有一次真正的请求打到 80 端口,也没有服务器参与跳转。是浏览器自己提前把协议改对了,而不是服务器又做了一次 301。

---

## 六、OIDC vs 长期 AWS 凭证

**传统方式**:把 AWS Access Key/Secret Key(长期有效的静态凭证)存成 CI 平台的 Secret。一旦泄露(日志打印、误公开仓库、钓鱼等),攻击者能一直用到人工发现并手动吊销。

**OIDC 方式**:CI 每次运行时,用 CI 平台自己签发的一次性 JWT 令牌去换一个几十分钟就过期的临时 AWS 凭证,CI Secrets 里根本不存放任何 AWS Key。

**更安全的两点叠加**,不只是"长期有效"这一个问题:
1. 不需要存放任何静态密钥,减少了"密钥在什么地方泄露"这个攻击面本身;
2. 即便某次运行的临时令牌泄露,过期后立刻失效,攻击窗口从"永久"缩小到"几十分钟"。

### OIDC 信任策略:Environment subject vs 分支 subject

CI 平台的 OIDC 令牌里有个 `sub`(subject)字段,IAM 信任策略靠这个字段认身份。它有两种格式:

- **按分支**:`repo:xxx:ref:refs/heads/master`——只要代码在 master 分支上跑,不要求任何审批。
- **按 Environment**:`repo:xxx:environment:prd`——job 必须声明了这个 Environment,而声明了就必须先过这个 Environment 配置的 required-reviewer 审批,才会真正开始跑、才会去申请令牌。

**关键设计**:生产部署角色的信任策略**只留 Environment 这一条路**,故意不加分支 subject。原因是如果两种都信任,以后任何人往 master 分支加一个**没有声明该 Environment 的新工作流**(哪怕是临时调试脚本、或者漏写了 `environment:` 字段),也能凭"我在 master 分支上"这个身份直接 assume 生产角色,完全绕过审批门禁。只留 Environment 这一条路径,才能把"能不能碰生产资源"和"有没有过人工审批"死死绑在一起,不留旁路。

（反过来,负责"派发部署时先通知一下"的 job 因为必须在审批**之前**跑,不能声明 Environment,只能退而求其次用风险较低的分支 subject——但它权限也刻意收窄到只能发个通知,碰不到任何有破坏性的资源。）

### 生产部署的二次确认(guard job)

在人工审批之外,手动派发生产部署工作流时,还要求操作者在输入框里手打一个确认字符串(比如 `deploy-prod`)。第一步跑的 `guard` job 会检查这个输入:没填/填错 → 直接失败退出,不会 assume 任何角色、不碰任何 AWS 资源;精确匹配 → 才继续走通知、审批、部署的完整流程。这是防"手滑误触发生产部署"的一道保险,和"必须过审批"是两层独立的保护。

---

## 七、S3 版本回滚为什么还需要 CloudFront 一起处理

**误区**:回滚要恢复旧的 S3 对象版本,那是不是说明还是在用 S3,CloudFront 是不是没必要?

**纠正**:回滚和"要不要用 CloudFront"是两件独立的事。用户实际看到的响应是 **CloudFront 边缘节点**返回的(它从 S3 拉取内容后缓存分发),不是直接访问 S3。回滚必须两步都做:
1. S3 里的内容变回旧版本;
2. **失效 CloudFront 缓存**——否则边缘节点上还留着回滚前的旧缓存,用户看到的还是没回滚成功的版本。

回滚不是"绕开 CloudFront 改回纯 S3",而是"S3 内容 + CloudFront 缓存"两层要一起处理,CloudFront 该有的边缘加速/HTTPS/OAC 保护/自定义错误响应这些能力全程都还在起作用,并没有因为回滚而被停用。

---

## 八、共享网络基础设施的成本归因坑

### 1. ECS task 标签不会自动继承 service 标签(propagateTags)

ECS service 可以打标签,但 task 是 service 动态启动的实例,默认**不会**自动继承。要让 Cost Explorer 能按标签把某个 task 的用量归到具体项目,必须显式把 `propagateTags` 设成 `SERVICE`(继承 service 标签)。设成 `NONE` 就意味着 task 层面没有任何标签,账单里几十个 ECS 服务的钱混在一起,没法用标签筛出"这是哪个项目花的"。

### 2. NAT Gateway 和 ALB 的关系

两者不是调用关系,而是同一批网络基础设施里"分管两个方向"的组件:

- **ALB** 管**进站**:接收外部用户访问,转发给后端 target group。
- **NAT Gateway** 管**出站**:私有子网里没有公网 IP 的资源(比如容器 task)要访问外网时,由它做地址翻译再出网。

它们经常部署在同一个 VPC 里,是因为一套典型的三层网络(公有子网+私有子网+VPC)天然同时需要"接外部流量进来"和"让内部资源能出去"这两种能力,不是谁依赖谁。也正因为两者都是被很多不相关服务共用的公共基础设施,它们的固定成本(按小时收费的部分)都没法精确归因到某一个具体项目——能省下来的只是这个项目自己那部分数据处理费用,数量级通常很小。

### 3. NAT Gateway ≠ 堡垒机(方向正好相反)

"内网 IP 不暴露"这个结论没错,但类比方向反了——两者做的是相反方向的事:

- **堡垒机**解决"外面的人怎么进来":给内网开一条**故意留的、受控的入站通道**,管理员统一从这一个加固、有审计的入口登录,再跳转到内网其他机器。
- **NAT Gateway**解决"里面的人怎么出去":私有资源用它做 SNAT(把源 IP 换成 NAT Gateway 自己的公网 IP)后访问外网,它**只处理内部发起的单向出站流量**,外部任何人主动发起的连接一律不接受、不转发——它彻底堵死了"从外部主动连进私有子网"这条路,不是一个能登录进去的入口。

一句话:堡垒机是"给外面的人开的一扇门,但只准走这一扇";NAT Gateway 是"给里面的人开的一扇单向窗,只能往外递东西,外面的人爬不进来"。

---

## 九、Terraform State 后端配置是干什么的

```hcl
terraform {
  backend "s3" {
    bucket       = "xxx-terraform-state"
    key          = "workloads/platform/xxx/dev/terraform.tfstate"
    region       = "ap-northeast-1"
    use_lockfile = true
    encrypt      = true
  }
}
```

这段配置**不创建任何 AWS 资源**,只是告诉 Terraform "这个环境的 state 文件存在哪"。Terraform 每次 apply 都要记录"现在建了什么、ID 是什么"这份 state,如果存本地,团队协作时容易冲突或丢失。这里的意思是:把这个环境的 state 存进团队公共的 S3 桶里,用 `key` 区分不同环境/项目的路径,`encrypt` 开启服务端加密,`use_lockfile` 防止两个人同时 apply 导致 state 损坏(并发锁)。通常这个桶本身是团队已有的公共基础设施,新项目只是新增一个自己的 `key` 路径,不需要新建桶。

---

## 十、澄清误区:S3+CloudFront 并不冷门,而是前端静态部署的"黄金组合"

**误区**:觉得 S3+CloudFront "部署少"、很少被提到,是个冷门方案。

**纠正**:在前端与静态资源(React、Vue、HTML/CSS、图片视频)的部署中,S3 + CloudFront 非但不冷门,反而是 AWS 生态乃至整个工业界最标准、用得最多的"黄金组合"(大厂与高并发场景的首选,成本极低、抗打能力强)。产生"冷门"的错觉,通常是以下三个原因造成的:

### 1. 绝对不能部署"后端服务"(它只有存储,没有算力)

S3 只是纯粹的对象存储(网盘),本身没有任何 CPU/内存去运行 Node.js、Python、Go、Java 等后端常驻代码。

- **能部署什么**:打包好的静态文件(`.html`、`.js`、`.css`、图片)。
- **不能部署什么**:真正的动态 API、后端微服务、数据库连接。凡是需要服务器计算的,必须交给 EC2/ECS/Lambda,S3+CloudFront 充其量只能作为最前方的静态 CDN。

### 2. 纯手动搭建的"开发者体验(DX)"太繁琐

对独立开发者和小团队,手动从零搭建 S3+CloudFront 的流程很折腾:S3 Bucket 策略、CloudFront OAC(参见本文第三节)、ACM 证书申请、Route 53 域名解析、SPA 单页路由重定向(404 映射,参见本文第四节)、CI/CD 部署时的缓存刷新(Invalidation,参见本文第二节)。

在这个领域,**Vercel、Netlify、Cloudflare Pages** 以及 AWS 自家的 **AWS Amplify** 夺走了大量声量——它们只需绑定 GitHub、点一下鼠标就能全自动搞定一切,把底层 S3+CloudFront 的复杂性全屏蔽掉了。

### 3. 现代前端 SSR(服务端渲染)趋势的冲击

早期前端全是纯静态 SPA(单页面应用),打包完就是一堆静态文件,丢进 S3+CloudFront 完美运行。但现在 **Next.js、Nuxt.js** 等框架大行其道,依赖 **SSR(服务端实时渲染 HTML)** 来优化 SEO 和首屏加载——前端代码在接收请求时也需要跑 Node.js 服务器,单纯的 S3 存不下了,大家转向 Vercel、AWS Lambda 或容器(ECS)部署。

### 场景落地总结

| 场景 | 标准方案 |
|---|---|
| 纯静态网站 / React/Vue SPA / CDN 静态资源加速 | **S3 + CloudFront**(大厂与高并发的首选,成本极低、抗打能力强) |
| Next.js / SSR 动态前端 | Vercel / AWS Amplify / ECS |
| 后端 API / 动态业务 | API Gateway + Lambda 或 ALB + ECS/EC2 |

## 十一、一句话总结

这次迁移评审的核心方法论是:**任何一条"听起来合理"的技术结论,都要么在 AWS 官方文档里找到原文佐证,要么用只读 CLI 命令在真实账户上实测验证,不凭直觉或惯性接受**——不管这个结论是外部评审提的,还是自己最初的判断。共享资源(ALB/NAT Gateway)的成本归因、CloudFront 错误改写响应的实际缓存行为、CSP Report-Only 到底会不会被日志记录,都是这么一条条查证出来的。

---

参考关联笔记:[ALB-vs-API-Gateway-vs-Bastion-Host.md](ALB-vs-API-Gateway-vs-Bastion-Host.md)(第九节:ACM 证书与免费/付费证书对比;第十节:TLS 卸载原理)
