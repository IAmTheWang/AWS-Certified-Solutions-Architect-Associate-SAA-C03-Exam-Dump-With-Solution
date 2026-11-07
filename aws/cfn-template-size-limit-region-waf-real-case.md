# CloudFormation 模板大小限制 / Region 与 us-east-1 / WAF 与边缘函数 实战笔记(基于 welby-lp-web PR 19 真实排查)

来源:在公司项目 `welby-lp-web`(静态 LP 托管仓库)review PR 19(`WLB_NEW_KARTE-5726`:让 `make deploy` 把 `lp.yml` 先上传 S3 再部署,并在 CI 里检查模板大小)时,用 AWS CLI(只读为主)实查出来的结论,外加 review 过程中顺带搞懂的一串 AWS 概念。比刷题记概念更容易记住,建议对照 SAA 考点复习。

> 标注说明:带「(已实测)」的是在本机跑出来的结果;带「(官方文档)」的是读了 AWS 官网页面;带「(我的理解,未核实)」的是凭 AWS 知识解释的,考前请对照官方文档确认。

---

## 1. 事故:`lp.yml` 超过 51,200 字节,`make deploy` 在所有环境都坏了

`lp.yml`(CloudFront + WAF + Route53 的模板)长到 **51,767 字节**(已实测:`wc -c`),而 `s3.yml` 只有 **1,888 字节**。部署报错:

```
Templates with a size greater than 51,200 bytes must be deployed via an S3 Bucket.
```

dev、stg、prd 全部失败,CI 却一直是绿的,五天后才被人手动建 stg 栈时发现。

### 把模板交给 AWS 的两条路

| 方式 | 上限 | 命令参数 |
|---|---|---|
| 直接塞进请求(inline,`TemplateBody`) | **51,200 字节** | `--template-body file://...` |
| 先传到 S3,让 AWS 去桶里取(`TemplateURL`) | **1,048,576 字节(1MB)** | `--template-url https://...`;`deploy` 命令用 `--s3-bucket` |

**比喻:寄一份很厚的合同。**
- inline = 把合同全文塞进**信封**寄出去,信封最多装 51,200 字节。
- S3 = 把合同放进**储物柜**,信封里只写"请到 3 号柜取"。信封里只有一行地址,所以不受信封大小限制,柜子能放到 1MB。

### 修法(PR 19)

`aws cloudformation deploy` 加上 `--s3-bucket <桶> --s3-prefix <栈名>`,CLI 会自己先把模板传到桶里再引用。注意:
- 存模板的桶**必须和栈在同一个 region**。`lp.yml` 栈在 `us-east-1`,所以模板桶 `cf-templates-...-us-east-1` 也在 `us-east-1`。
- `s3.yml` 栈在东京(`ap-northeast-1`)且只有 1,888 字节,继续 inline,不值得再维护一个东京的模板桶。
- 51,200 以上不算错误(因为已走 S3),1,048,576 以上才是真错误(没有更大的通道了)。

### 修完之后还剩一个坑:`make validate` 仍然坏

`make validate` 用的是 `aws cloudformation validate-template --template-body file://...`,同样受 51,200 限制。已实测:

```
$ aws cloudformation validate-template --template-body file://_deploy/cloudformation/lp.yml
An error occurred (ValidationError) ... Member must have length less than or equal to 51200
```

而 `s3.yml`(1,888 字节)能通过。对策二选一:`validate` 也改成 `--template-url`;或在文档里写明"`make validate` 无法覆盖 `lp.yml`,实际检查靠 CI 的 cfn-lint"。

---

## 2. Makefile 里 `validate` 和 `_validate` 是两回事

| | `validate` | `_validate` |
|---|---|---|
| 谁能敲 | 用户自己敲 | 内部帮手,被 `deploy`/`describe`/`delete` 等当作前置步骤调用 |
| 做什么 | 把模板寄给 AWS,问"格式对不对" | 检查参数、补默认值、打印本次设置、危险组合警告、prd 要手动输入 `production` 确认 |
| 调用 AWS 吗 | **调用**(联网,受 51,200 限制) | **不调用**(纯本地检查) |

**"调用 AWS"是什么意思?**
- 不调用:只在自己电脑上检查,像"检查表格必填栏有没有填",不需要联网和登录。
- 调用:把东西寄给 AWS 的服务器,让它回答,要联网、要凭证,也会撞上 AWS 的各种限制。

**比喻:安检口。** `_validate` 是每个危险操作之前统一过的安检口(只在本地看你带没带违禁品);`validate` 是真的去政府窗口递材料。Makefile 里下划线开头 = "内部目标,不要直接敲"的约定。

## 3. `cfn-lint` vs `validate-template` vs 大小检查

| 工具 | 在哪跑 | 检查什么 | 要登录 AWS 吗 |
|---|---|---|---|
| `cfn-lint` | 本地 / CI | 模板**内容**:属性写错、参数类型、某 region 不支持的资源 | 不要 |
| `aws cloudformation validate-template` | 把模板发给 AWS | 基础语法;受 51,200 限制 | 要 |
| `_deploy/ci/cfn-template-size`(PR 19 新增) | CI | 模板**大小** | 不要 |

**比喻:** `cfn-lint` 是文章的"拼写语法检查器",只管内容对不对,不管文章几页;大小限制是"邮寄通道的容量",属于**投递方式**的性质,不是文档本身的性质。所以 cfn-lint 全绿,模板照样发不出去。这就是为什么要另写一个大小检查器。

---

## 4. Negative control(反向对照测试)

普通测试:"正常情况下它应该通过"。Negative control:**故意制造错误情况,确认检查器会报警**。

**比喻:测火警报警器,要故意点一支烟。** 否则检查器哪天被改坏、永远输出"正常",CI 一直绿,实际已失效(和这次事故一模一样:CI 绿了五天其实没在检查大小)。

PR 19 的做法:造一个 1,048,577 字节的假文件,要求检查器**必须失败**;造一个 51,201 字节的假文件,要求检查器**必须成功且报告**。

**为什么要同时断言「退出码」和「token」?**
- **退出码**:每个命令跑完留下的数字,`0`=成功,非 0=失败,CI 靠它判红绿。
- **token**:脚本打印的固定标记词(如 `OVER_S3_LIMIT <文件名>`),方便程序用关键词查找。
- 只看退出码:脚本崩溃、找不到文件也是非 0,会把"检查器坏了"误当成"检查器工作正常"。再加上 token 和文件名,才能证明"是因为文件超标才失败"。

---

## 5. Region / AZ / 边缘节点

- **Region** = 一个地理区域(如东京);**AZ(可用区)** = region 里相互隔离的机房组。每个 region 至少 3 个 AZ(官方文档)。
- **边缘节点(edge location / POP)** 遍布全球,CloudFront 就近给用户返回内容。

官方数字(官方文档/首页,读取于 2026-11):首页写 "124 Availability Zones within 39 Geographic Regions"、"750+" 个 CloudFront POP、"15" 个 Regional edge caches。文档 Regions 表格写 "currently 34 Regions"(普通账号可用的那张表)——**两处数字不一致,原因我没有查清**(猜测与 GovCloud/中国区等有关,未核实)。

亚太地区(官方文档表格):

| 地区 | 代码 | AZ 数 | 默认可用? |
|---|---|---|---|
| 东京 | `ap-northeast-1` | 4 | 是 |
| 大阪 | `ap-northeast-3` | 3 | 是 |
| 首尔 | `ap-northeast-2` | 4 | 是 |
| 新加坡 | `ap-southeast-1` | 3 | 是 |
| 悉尼 | `ap-southeast-2` | 3 | 是 |
| 孟买 | `ap-south-1` | 3 | 是 |
| 香港/台北/雅加达/墨尔本/马来西亚/新西兰/泰国/海得拉巴 | `ap-east-1`/`ap-east-2`/`ap-southeast-3`/`4`/`5`/`6`/`7`/`ap-south-2` | 均 3 | **需手动开启**(2019-03-20 之后新增的 region) |

对比:`us-east-1` 有 6 个 AZ。**单个机房的规模,AWS 官方页面没有公开**(没有 AZ 大小、每 AZ 机房数、AZ 间距离),网上流传的"一个数据中心几万台服务器"不是官方数据,别当事实。

### `--region` 是什么

**比喻:AWS 在世界各地有很多"城市窗口",`--region` 指定你的命令寄到哪个城市。** 不写就用 profile 默认的城市。

已实测:profile 默认 region 是 `ap-northeast-1`(东京),桶在 `us-east-1`,但 `aws s3api head-bucket --bucket <桶>` **不加 `--region` 也成功(exit 0)**——S3 会把你重定向到对的窗口。所以这个 PR 里 `head-bucket` 不加 `--region` 不是缺陷。

---

## 6. 为什么 CloudFront / WAF / ACM / Lambda@Edge 必须在 us-east-1

**先澄清一个容易误解的点:不是网站内容放在美国。** 内容由全球边缘节点就近返回,东京用户基本从日本的边缘节点拿内容。us-east-1 放的是**"管理层 / 总部登记处"**:创建、修改 CloudFront 的配置写到这里,再分发到全球边缘。

**比喻:连锁便利店。** 门店(边缘节点)开在全世界,顾客就近购买;但"总部登记处"只有一个,所有门店的规矩都在总部登记再下发。要改规矩,必须去总部登记。

| 资源 | 必须在 us-east-1 吗 | 说明 |
|---|---|---|
| CloudFront 配置 | 是 | 全球服务,管理入口在此 |
| WAF(scope = `CLOUDFRONT`) | 是 | 要挂在 CloudFront 上,跟着总部走 |
| ACM 证书(给 CloudFront 用) | 是 | SAA 经典考点 |
| Lambda@Edge | 是(创建时) | 见第 9 节 |
| Route 53 | 不分区域 | 全球服务 |
| 放网页文件的 S3 桶 | 否,可在东京 | 普通 region 服务 |

对应这个仓库(`lp.yml` 里 `Scope: "CLOUDFRONT"`,`_AWS_GLOBAL_REGION=us-east-1`):
- `lp.yml` 栈(CloudFront + WAF + Route53)→ `us-east-1`
- `s3.yml` 栈(放网页的桶)→ `ap-northeast-1`
- 模板桶 `cf-templates-...-us-east-1` → `us-east-1`(要和 `lp.yml` 栈同 region)

(这一节"为什么必须在 us-east-1"的原因,官方这次读的两个页面没有讲,是我的理解,未核实;考前可查 CloudFront 文档里关于 WAF 和 ACM 证书必须在 us-east-1 的说明。)

---

## 7. WAF:为什么还要单独配一个"保安"

CloudFront 本职是**把内容送出去**,它不会判断"这个请求是不是坏人发的"。

**比喻:CloudFront 是便利店店员,负责递商品;WAF 是门口保安,负责检查来的人。** 让店员兼职保安既不专业,规则也没法单独调整。

在这个仓库里,WAF 的实际用途是 dev/stg 环境的 **IP 白名单**:只放行公司出口地址,其他来源一律拦截(`waf=ip-restricted`)。prd 是公开站点,用 `public` 模式。

### WAF 的两种 scope

| scope | 保护谁 | 创建在哪 |
|---|---|---|
| `REGIONAL` | 某区域里的资源:ALB、API Gateway、AppSync、Cognito 用户池等 | 和被保护资源**同一 region** |
| `CLOUDFRONT` | CloudFront 的 distribution | **必须 us-east-1** |

**比喻:** `REGIONAL` 保安是派驻到某一家分店门口的;`CLOUDFRONT` 保安守的是总部登记处定的规矩,由总部统一下发到所有门店。同一套 WAF 里,IP 名单(IPSet)和规则本体(WebACL)的 scope 必须一致。

### `waf=` 参数为什么要检查(`_validate` 里)

1. **值是否合法**:只接受 `public` / `ip-restricted` / `none`。make 对不认识的参数名会**悄悄忽略**,打错字(如 `ip_restricted`)不会报错,以为设了限制其实没生效。
2. **旧值映射提示**:历史上的 `waf=true` 实际是"挂了 WAF 但允许所有人",**从没限制过任何东西**,名字却让人以为开启了保护。现在映射成 `public` 并提示。
3. **危险组合警告**:`ip-restricted` 但没给 `allowed_ipv6=` 时,新栈用模板默认的 `::1/128`,**会挡掉所有走 IPv6 的访客**(见下一节)。

## 8. IP / IPv4 / IPv6 / `::1/128`

- **IP = Internet Protocol(互联网协议)**。IP 地址 = 设备在互联网上的"门牌号"。IPv4/IPv6 的 4 和 6 是协议**版本号**。
- IPv4:`203.0.113.5`,约 43 亿个,已不够用。IPv6:`2001:db8::1`,数量极其庞大,手机运营商和家用宽带越来越多在用。
- 同一个用户访问网站可能走 IPv4 也可能走 IPv6,所以做 IP 白名单要**两种都写**,只写一种,另一种用户会被挡掉。
- `::1/128` = IPv6 里的"本机自己"(类似 IPv4 的 `127.0.0.1`),`/128` 表示只精确匹配这一个地址。模板把 `AllowedIPv6` 默认设成它,意思是"除了机器自己谁都不放行",所以新栈如果漏配 IPv6 白名单,等于挡掉所有 IPv6 访客。(CIDR 写法见 [IAM-Policy-Evaluation-and-CIDR-Notation.md](../notes/IAM-Policy-Evaluation-and-CIDR-Notation.md))

### 8.1 IPv4 vs IPv6 对照

| | IPv4 | IPv6 |
|---|---|---|
| 地址长度 | 32 位 | 128 位 |
| 地址数量 | 约 43 亿个 | 约 3.4×10³⁸ 个 |
| 写法 | `203.0.113.5`(点分十进制) | `2001:db8::1`(冒号分隔十六进制,连续的 0 可用 `::` 省略) |
| 是否需要 NAT | 通常需要(多设备共用一个公网地址) | 不需要(每个设备可有自己的公网地址) |
| 包头 | 长度不固定,字段多,带校验和 | 固定 40 字节,更简单 |
| 自动获取地址 | 主要靠 DHCP | 可自己生成(SLAAC),也可用 DHCPv6 |
| 广播 | 有 | **没有**,改用多播和任播 |
| 互通 | **不能直接互通**,需要双栈(dual stack)或转换 | 同左 |

**比喻:IPv4 = 8 位电话号码,快用光了;IPv6 = 给每一粒沙子都分配一个独立号码。** 老电话打不通 20 位的新号码,所以要"同时装两部电话"(双栈)或一台翻译机。IPv6 不是 IPv4 的替代品,现实中长期并存。

### 8.2 NAT / DHCP 是什么

- **NAT = Network Address Translation(网络地址转换)**。**比喻:公司总机。** 公司只有一个对外号码(公网 IP),每个员工是分机号(内网 IP);员工往外打,总机替你拨;外面回电,总机再转给分机。外界看不到分机。副作用(也是好处):**外部无法主动打给某个分机**,天然实现"内部能出去、外部进不来"。
- **DHCP = Dynamic Host Configuration Protocol(动态主机配置协议)**。**比喻:酒店前台。** 你一入住,前台自动发房卡(IP 地址),退房收回。电脑/手机连上 Wi-Fi 自动拿到 IP 就是 DHCP。

### 8.3 单播 / 广播 / 多播 / 任播

| | 比喻 | 谁收到 |
|---|---|---|
| 单播 unicast | 打一对一电话 | 一个人 |
| 广播 broadcast | 拿大喇叭对整栋楼喊话 | 同一网络里**所有设备** |
| 多播 multicast | 微信群发消息 | 只有**订阅了该频道**的设备 |
| 任播 anycast | 全国统一客服号 400-xxx | 一个号码对应多台机器,**自动转给最近的一台** |

**为什么要广播?** 因为有时设备**不知道该找谁**:刚连网的电脑不知道 DHCP 服务器在哪,只能先对所有人喊"有人能给我发 IP 吗?"。缺点是会打扰同网络每台设备,所以 IPv6 取消了广播,改用多播。任播的真实例子:AWS Global Accelerator 提供的固定 IP。

### 8.4 DNS 的 A 记录 vs AAAA 记录

DNS = 互联网的电话簿(域名 → 地址)。

- **A 记录**:域名 → **IPv4** 地址。
- **AAAA 记录**(读 "quad-A"):域名 → **IPv6** 地址(IPv6 地址是 IPv4 的 4 倍长,所以 4 个 A)。

这个仓库的 Route53 记录是 **A(ALIAS)**,只有 IPv4 这一类。

### 8.5 实战:怎么查我们的 CloudFront 开没开 IPv6

`lp.yml` 里**没有**显式设置 CloudFront 的 IPv6 开关(`grep -i "IPV6Enabled"` 无结果),但第 117–120 行 `AllowedIPv6` 参数的注释写着 "CloudFront is IPv6-enabled and dual-stack clients may present an IPv6 address"——这是作者的说法,**线上实际值未核实**。三种查法:

```bash
# 1) 控制台:CloudFront → 选 distribution → General → Settings → IPv6 是 On/Off

# 2) CLI(只读)
aws cloudfront list-distributions --query "DistributionList.Items[?Aliases.Items[0]=='<域名>'].Id" --output text
aws cloudfront get-distribution-config --id <上一步的ID> --query 'DistributionConfig.IsIPV6Enabled'

# 3) 直接查 DNS(不用登录 AWS)
dig AAAA <域名> +short     # 有返回 IPv6 地址 = 对外提供 IPv6;无返回 = 只有 IPv4
```

**命令里的 `<域名>` 指什么:** 指这个 distribution 对外服务的**自定义域名(alias / CNAME)**,也就是用户在浏览器里输入的网址,在这个仓库里命名规则是 `{host}{suffix}.welby.jp`(如 `www-stg.welby.jp`、`www.welby.jp`)。**不是** CloudFront 自己分配的 `dxxxx.cloudfront.net`。不知道域名时,可以先列出全部 distribution 及其 alias 再挑:

```bash
aws cloudfront list-distributions --query "DistributionList.Items[].{Id:Id,Domain:DomainName,Aliases:Aliases.Items}" --output table
```

**一个值得注意的发现:** 自定义域名只配了 **A 记录**,所以用这个域名访问的人,DNS 只会返回 IPv4 地址,访客基本走 IPv4。因此"IPv6 白名单没配会挡掉所有 IPv6 访客"在实际中**可能很少触发**,更像是模板作者的预防(未用 `dig AAAA` 验证线上是否有 AAAA 记录)。

### 8.6 `::1/128` 默认值到底在干什么

1. `ip-restricted` 模式 = **只允许名单里的 IP,其余全拦**。
2. IPv6 名单默认值是 `::1/128`,`::1` 是 IPv6 的"**本机自己**"(类似 `127.0.0.1`)。
3. 真实访客的 IPv6 一定是他自己的公网地址,**永远不会是 `::1`**,所以名单里没有任何真实访客 → **所有 IPv6 访客都被拦**。

**比喻:活动访客名单上只写了"我自己"**,任何真正来访的人都不在名单上,全被拒之门外。所以模板用 `ip-restricted` 时要同时传 `allowed_ipv6=`,否则等于拒绝所有 IPv6 访客。

### 8.7 VPC 里的 IPv6:NAT Gateway vs Egress-only Internet Gateway

- **IPv4 私有子网要访问外网 → NAT Gateway。** 员工通过总机往外打,外面打不进来(NAT 的副作用)。
- **IPv6 地址是公网可路由的**,不需要"转换成总机号码",也就没有"藏起来"的效果。如果直接接普通 Internet Gateway,**外部就能主动连进来**。
- 所以 AWS 提供 **Egress-only Internet Gateway**。**比喻:地铁出站口的单向旋转门,只能出不能进**:内部可以主动访问外部,外部不能主动连进来。

| 场景 | 用什么 |
|---|---|
| 私有子网 IPv4 服务器访问外网 | **NAT Gateway** |
| 私有子网 IPv6 服务器访问外网,且不让外部主动连入 | **Egress-only Internet Gateway** |

**更正(重要):** "NAT Gateway 只能给 IPv4 用"说得太绝对。准确说法:NAT Gateway 的核心工作是 **IPv4 地址转换**;AWS 后来还加了 **NAT64** 模式,用于让"只有 IPv6 的机器"访问 IPv4 服务(我的理解,考前请对照官方文档)。

### 8.8 IPv4 与 IPv6 现在谁更多

未能取得准确的最新数字(Google 的 IPv6 统计页面数据在图表里,文本读不到)。能确定的只有:按**地址数量**比没有意义(IPv4 因为 NAT,一个公网地址背后可能有成千上万台设备);按**用户访问量**比,近几年全球大约有接近一半的用户用 IPv6 访问 Google(我的印象,未核实,以 Google IPv6 统计页面实时图表为准);各国差异很大。

### 8.9 `IsIPV6Enabled = true` 到底是什么意思(实测)

在 CloudFront distribution 上实际跑:

```bash
$ aws cloudfront get-distribution-config --id E1OGHY9HU50DNU --query 'DistributionConfig.IsIPV6Enabled'
true
```

**`true` = 双栈(dual stack):IPv4 和 IPv6 访客都能访问;不是"只有 IPv6 才能访问"。** CloudFront 没有"仅 IPv6"这个选项。`false` 才是只有 IPv4。(该 ID 对应哪个环境,由用户本机执行,我没有核实。)

**比喻:一家店原来只有一个正门(IPv4),开了 IPv6 等于再加一个侧门,两个门都能进,不是把正门关掉。**

**但"开关开了"≠"真有人走 IPv6"。** CloudFront 开了 IPv6 只说明它**有能力**接待 IPv6 访客;访客要真的走 IPv6,还得靠 **DNS 先给他一个 IPv6 地址**,也就是域名上要有 **AAAA 记录**。

### 8.10 实测:CloudFront 开了 IPv6,但 `thylog.welby.jp` 没有 AAAA 记录

```bash
$ dig AAAA thylog.welby.jp
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 53680
;; flags: qr rd ra; QUERY: 1, ANSWER: 0, AUTHORITY: 1, ADDITIONAL: 1
;; QUESTION SECTION:
;thylog.welby.jp.		IN	AAAA
;; AUTHORITY SECTION:
welby.jp.		900	IN	SOA	ns-1358.awsdns-41.org. awsdns-hostmaster.amazon.com. 1 7200 900 1209600 86400
```

怎么读这段输出:

| 输出里的内容 | 意思 |
|---|---|
| `status: NOERROR` | DNS 查询成功,域名**存在**(若是 `NXDOMAIN` 才是域名不存在/拼错) |
| `ANSWER: 0` | 问的是 AAAA,**答案数量为 0 = 没有这条记录** |
| `AUTHORITY SECTION ... SOA` | 管这个区域的权威 DNS 回话:"我是权威,确实没有这条" |
| `ns-1358.awsdns-41.org` | 名字里的 `awsdns` 说明 DNS 托管在 **Route 53** 上,印证 AGENTS.md |
| SOA 行开头的 `900` | "没有这条记录"这个答案可被缓存的秒数(约 15 分钟,我的理解);以后补了 AAAA,别处的 DNS 缓存最长可能还要这么久才更新 |
| `SERVER: ...` | 你本机用的 DNS 解析器(路由器/公司网络),不是直接问 Route 53;可用 `dig AAAA <域名> @8.8.8.8 +short` 交叉验证 |

**结论:**

| 项目 | 状态 |
|---|---|
| CloudFront IPv6 开关 | `true`,有能力接待 IPv6 |
| 域名 AAAA 记录 | **没有** |
| 实际结果 | 用 `thylog.welby.jp` 访问的人,DNS 只返回 IPv4(A 记录),**基本都走 IPv4** |

所以"IPv6 白名单没配会挡掉所有 IPv6 访客"(`::1/128` 默认值,见 8.6)在这个域名上**实际很少触发**,更像模板作者的预防。**如果以后给域名加 AAAA(ALIAS)记录**,IPv6 访客才会真的走 IPv6:`public` 模式一般没问题;`ip-restricted` 模式必须同时给 `allowed_ipv6=`,否则这些访客会被全拦(我没有查 thylog 现在用哪种 WAF 模式)。

**方法论:开关打开了 ≠ 真的有流量走这条路,要用 DNS 实查最终的链路。**

---

### 8.11 `www` 是什么

**www = World Wide Web(万维网)。** 先分清:

| | 是什么 | 比喻 |
|---|---|---|
| **Internet(互联网)** | 全世界联网设备相互连接的**网络本身** | 道路系统 |
| **WWW / Web** | 跑在互联网上的一种**服务**:用 HTTP/HTTPS 访问、靠链接跳转的网页 | 道路上开的商店 |
| **域名里的 `www` 三个字母** | 一个**习惯用的主机名/子域名**,表示"这是网页服务的入口" | 商店门口挂的"营业部"牌子 |

邮件、文件传输、游戏也走互联网,但不属于 Web。

**以 `www.welby.jp` 为例,从右往左读:** `jp`(顶级域名 TLD,日本)→ `welby`(二级域名,公司名)→ `www`(主机名/子域名)。**比喻:地址。** 日本 → welby 公司 → 公司里负责对外网页的那个窗口。

### www 是谁定义的?为什么要用它开头?

**没有任何人、任何标准规定"网站必须叫 www",它只是约定俗成的习惯。** Web 由 Tim Berners-Lee 在 CERN 发明(约 1989–1991);但"网页服务器的主机名叫 www"不是写进规范里的强制规则。

流行原因(我的理解,未逐条核实原始资料):当时习惯**用服务名给机器取名**(`mail`、`ftp` 等),管理员自然把网页服务器叫 `www`;好处是以后把服务搬到另一台机器,只要改名字指向哪里,用户的网址不用变。我印象中 IETF 有一份文档(RFC 2219)建议用这类服务名做别名,**未核实**。另外 Berners-Lee 本人也承认 `www` 念起来麻烦(缩写比全称 World Wide Web 的音节还多)。

### 为什么有的网站没有 www?

`www` 不是必须的,只是历史习惯:
1. 当年它的作用是"区分用途":`www.example.com` 网页、`mail.example.com` 邮件、`ftp.example.com` 文件传输。
2. 现在网页成了绝对主流,很多网站省略它:用**裸域名**(`example.com`),或用更有意义的名字(如 `thylog.welby.jp`、`dda.welby.jp`)。
3. 技术上的历史原因:DNS 规则不允许**裸域名上设 CNAME**,早期接 CDN(要用 CNAME)只能用 `www.example.com`;现在 Route 53 的 ALIAS 解决了这个问题,所以省略 `www` 变得常见(见 8.12)。
4. 很多网站两个都能访问,其中一个自动跳转到另一个,避免出现两个"版本"。

这个仓库的 LP 域名都是平级的子域名,`www`、`thylog`、`dda`、`ltfu-p-cdn`、`karte-migration` 只是名字不同,各自指向不同的 CloudFront + S3 桶(Makefile 里用 `host=www`、`host=thylog` 区分)。

(日语聊天里的 `www` 是"笑"的意思,一个 `w` 一声笑,和网址里的 `www` 无关。)

### 8.12 CNAME vs ALIAS vs A

**CNAME = Canonical Name(规范名称)记录:把一个域名指向另一个域名,而不是指向 IP。**

| 记录 | 指向什么 | 例子 |
|---|---|---|
| **A** | 一个 IPv4 地址 | `www.example.com → 203.0.113.5` |
| **AAAA** | 一个 IPv6 地址 | `www.example.com → 2001:db8::1`(4 个 A,因为 IPv6 地址是 IPv4 的 4 倍长) |
| **CNAME** | 另一个域名 | `www.example.com → d1234.cloudfront.net` |
| **ALIAS**(Route 53 特有) | 某个 AWS 资源 | `thylog.welby.jp → CloudFront 分配` |

**解析过程(CNAME):** ① 访客查 `www.example.com`,DNS 答"这是 `d1234.cloudfront.net` 的别名";② 访客再查 `d1234.cloudfront.net`,才拿到真正的 IP。好处:对方换 IP,你这边自动跟着变。

### CNAME 的限制 → ALIAS 的由来

一个名字上只要有 CNAME,就**不能同时有别的记录**(如 MX)。**裸域名**上必然有 NS、SOA 等基础记录,所以**裸域名上不能设 CNAME**。ALIAS 就是 Route 53 为此设计的:它对外表现为 `A`(或 `AAAA`)记录,所以不违反规则,可以放在裸域名上。

### 比喻:公司前台

你想找"王老师",但他的工位经常换:

- **A 记录 = 直接递给你一张写着房间号的名片。** 房间一换名片就过期,要人手动改。
- **CNAME = 前台给你一块转接牌:"请去看另一块牌子 `王老师的工位牌`。"** 你自己再走过去看那块牌子才知道房间号,**多走一步**。
- **ALIAS = 前台替你代办。** 你问"王老师在哪?",前台**自己去查**最新位置,直接告诉你"305 房间"。你不知道中间还有一步,感觉像前台本来就知道(看起来是普通 A 记录)。

| | CNAME(转接牌) | ALIAS(前台代办) |
|---|---|---|
| 谁来跟踪变化 | 访客自己多查一步 | **Route 53 内部**查好 |
| 访客看到什么 | "去查另一个域名" | 直接是 IP,像普通 A 记录 |
| 能用在裸域名上吗 | **不能** | **能** |
| 能指向什么 | 任意域名 | **只能指向 AWS 的资源**(CloudFront、ALB、S3 网站端点等) |
| 谁提供 | DNS 国际标准,所有 DNS 服务都有 | **Route 53 自己的功能** |

**为什么 ALIAS 只能指向 AWS 资源?** 前台(Route 53)只认识自家大楼(AWS)里的人,所以只能代办自家的事;指向外面的任意域名,还得用 CNAME。

**对应这个仓库:** `lp.yml` 里的 Route 53 记录是 **A(ALIAS)** → CloudFront。翻译一下:访客问 `thylog.welby.jp` 在哪 → Route 53 自己去查 CloudFront 的最新地址 → 直接回答一个 IPv4 地址。类型写的是 `A`,所以只返回 IPv4;要让 IPv6 访客也找得到,需要再加一条 **AAAA(ALIAS)**,原理一样。

SAA 常考:Route 53 的 ALIAS 指向 AWS 资源时,查询通常免费,且能用在裸域名上,这是它相对 CNAME 的两个优势(费用这点是我的印象,考前请核对官方文档)。

### 8.13 "www.example.com 自动跳转到 example.com" 是 CNAME 还是 ALIAS?——都不是

**自动跳转(redirect)是 HTTP 层的事,不是 DNS 层的 CNAME/ALIAS。** 两者完全不同:

| | DNS 记录(A / CNAME / ALIAS) | 自动跳转(redirect) |
|---|---|---|
| 工作在哪一层 | **DNS 层**:把名字翻译成地址 | **HTTP 层**:网站服务器/CDN 回复的一条指令 |
| 谁来做 | DNS 服务器(如 Route 53) | 网站服务器 / CDN(如 CloudFront、S3、Nginx) |
| 浏览器地址栏会变吗 | **不会变** | **会变** |
| 访客感觉 | 完全无感 | 能看到网址变了 |

DNS 记录只负责"这个名字指向哪台机器",**没有能力改变浏览器里显示的网址**。

**比喻:**
- **DNS 记录 = 指路牌**:告诉你"`www` 这家店在这栋楼、`example.com` 这家店也在这栋楼"。你走进去,门牌还是你当初找的那个名字。
- **HTTP 跳转 = 店员在门口告诉你**:你按 `www` 的地址找到了店,店员说"本店已搬到隔壁,请去 `example.com`",于是你被带到另一个门口,**地址栏也跟着变了**。

**实际过程:**
1. 浏览器用 DNS 查 `www.example.com` 的地址(**这一步才用到 A / CNAME / ALIAS**);
2. 连上服务器,请求 `www.example.com`;
3. 服务器回复 `301 Moved Permanently`,并带 `Location: https://example.com/`;
4. 浏览器自动去访问 `example.com`,地址栏变成新的。

第 3 步才是"跳转",和 DNS 无关。

**怎么亲眼看到:** 用 `curl -I` 只看响应头(把域名换成你要查的真实域名):

```bash
curl -sI https://<域名>
```

若配了跳转,输出会有类似下面的内容(**示意,非实测输出**):

```
HTTP/2 301
location: https://example.com/
```

`301` = 永久跳转,`302` = 临时跳转,`location` = 要去的新地址。

**为什么不只靠 DNS 让两个名字指向同一处?** 可以做到,两个网址都能直接访问、各显示各的地址,但会变成"同一个网站有两个网址"(例如搜索引擎会当成两个站,这点是我的理解)。多数网站选一个当正式地址,另一个用 HTTP 跳转过去。

**对应这个仓库(两种机制同时存在,但不是一回事):**

| 例子 | 机制 | 层级 |
|---|---|---|
| 域名指向 CloudFront | Route 53 的 `A(ALIAS)` 记录 | DNS 层 |
| `/` 跳到 `/index.html` | `LPRootRedirectFunction`(CloudFront Function)返回 `302`,只对 GET/HEAD 做,保留 query string | HTTP 层 |
| 无扩展名、无斜杠的路径(如 `/lp/maternity`)跳到带斜杠形式 | `LPDirIndexFunction` 返回 `301`(故意用跳转而不是改写,否则页面里的相对路径会解析错) | HTTP 层 |

(以上两个 Function 按 AGENTS.md 的说明只在 multi-origin 模式、即 `karte-migration` 这类 LP 里存在。)

### 8.14 DNS 层 vs HTTP 层:一个比喻讲完两层

**场景:你想去一家叫 `thylog.welby.jp` 的店。整个过程分两个完全不同的阶段。**

**第一阶段:DNS 层 = 查号台 / 电话簿。** 你只有店名,不知道店在哪条街,先打电话到**查号台**(Route 53)问"`thylog.welby.jp` 在哪?",它答"在 XX 路 123 号"(= IP 地址)。查号台**只回答地址**,不管你去了以后店里发生什么,也不能让你改去别的店。A、CNAME、ALIAS 只是查号台里**怎么登记地址的几种写法**:A = 直接写门牌号;CNAME = 写"请再去查另一个名字";ALIAS = 查号台自己替你查好直接告诉你门牌号。

**第二阶段:HTTP 层 = 到了店门口,跟店员对话。** 你走到店里:你说"我要看首页"(HTTP 请求),店员说"好的,给你"(`200 OK`)。店员还能说别的:"这家店搬了,请去隔壁"(`301`)、"这个房间你进不去"(`403`)、"我们没有这个东西"(`404`)。**你的"地址栏"(你以为自己在哪)是在这一阶段才可能被改变的。**

| | DNS 层 | HTTP 层 |
|---|---|---|
| 比喻 | 查号台、电话簿 | 到了店里跟店员对话 |
| 回答什么 | "店在哪里" | "你要什么、我怎么回应" |
| 能不能让地址栏变 | **不能** | **能**(301/302 跳转) |
| 常见内容 | A、AAAA、CNAME、ALIAS | 200、301、302、403、404 |
| 这个仓库里谁负责 | **Route 53** | **CloudFront**(及其 Function、WAF、S3 源站) |

### 把之前所有比喻放进同一条访问路线

```
你想访问 thylog.welby.jp
  │
  ├─① 打电话问查号台(Route 53)           ← DNS 层:问地址
  │     "在哪?" → 给你一个地址
  │
  ├─② 走到门口(CloudFront 边缘节点)
  │     │
  │     ├─ 门口保安(WAF)                   ← HTTP 层:检查你是谁,不让进就拦下
  │     ├─ 门口迎宾员(CloudFront Function)   ← HTTP 层:看一眼就改路/跳转,如 "/ → /index.html"
  │     └─ 进去后拿东西(回源到 S3)         ← HTTP 层:把页面拿给你
  │
  └─③ 页面送到你手里
```

- **Route 53** 只出现在第 ① 步(DNS 层)。
- **WAF、CloudFront Function、S3** 都出现在第 ② 步(HTTP 层)。
- 所以 `LPRootRedirectFunction` 把 `/` 跳到 `/index.html`,是**店员在门口说话**,不是查号台的事。

**一句话记忆:** DNS 层只管"店在哪",说完就结束,不改你要去的网址;HTTP 层是到了店里的所有对话,包括"请去隔壁"。

---

## 9. CloudFront Functions vs Lambda@Edge

**原则:能用 CloudFront Functions 就用它,做不到再升级 Lambda@Edge。**

**比喻:**
- **CloudFront Functions = 门口的迎宾员,手里只有一张便签纸。** 站在每一家分店门口(全球 750+ 个边缘节点),只做"看一眼、改一下、放行"这种瞬间能完成的事。没有电话,不能出门,看不到顾客带的包(请求体)。因为规矩简单,所以特别快、特别便宜,能同时接待非常多顾客。
- **Lambda@Edge = 区域据点的专员,带完整办公室。** 只驻守在少数区域据点(官网写的是 15 个 Regional edge caches),有完整环境:能打电话(联网)、翻文件、处理更久的任务。但每次叫他出来有"进办公室开电脑"的准备时间(冷启动),人力成本也更高。

"轻/重"的本质:前者是限制很严的小沙箱,后者是完整的 Lambda 运行环境。

| | CloudFront Functions | Lambda@Edge |
|---|---|---|
| 位置 | 全球边缘节点 | 区域级据点 |
| 能联网吗 | 不能 | 能 |
| 速度/成本 | 极快、便宜 | 较慢、较贵 |
| 适合 | 重定向、改请求头、改 URL | 需要联网、读请求体、回源阶段处理、缩放图片 |
| 这个仓库 | **在用**:`LPRootRedirectFunction`(`/`→`/index.html`)、`LPDirIndexFunction`(补 `index.html`) | `lp.yml` 里没有(只有一个旧 PR 提过) |

(以上位置对应关系和能力差别,是我的理解,具体限制数字——执行时长、内存、语言——请以官方文档为准。)

### Lambda@Edge 为什么要在 us-east-1 创建

流程:① 在 **us-east-1** 创建函数并发布带编号的版本(不能用 `$LATEST`);② 把版本关联到 CloudFront 行为;③ CloudFront 把它**复制**到全球边缘。**比喻:总部写好门店操作手册,登记在总部,再统一复印发到各分店;分店不能自己写一份就生效。** 这是 AWS 的设计要求,具体理由(复制的源头在 us-east-1)是我的理解,未核实。

### Lambda@Edge 日志为什么在"最近的 region"

事实:日志写到**离函数实际执行位置最近的 region** 的 CloudWatch(日志组名通常类似 `/aws/lambda/us-east-1.<函数名>`)。

"为什么"(我的推断):**比喻:全球各分店店长每做一件事都要写记录,若每份都寄回总部登记要跨半个地球,又慢又贵,还可能拖慢工作;就近存放在最近的档案室更合理。**

**排查时的后果:** 东京用户触发的执行,日志在东京 region;美国用户触发的,在美国对应 region。**不能只看 us-east-1**,要去流量来源对应的 region 找。SAA 经典陷阱:函数在 us-east-1 创建,日志却不在 us-east-1。

---

## 10. `DeletionPolicy: Retain`(这个仓库里的真实用例)

`lp.yml` 里 Route53 A(ALIAS)记录设了 `DeletionPolicy: Retain`:删栈时**保留**这条记录。原因:要支持 `create_dns=false` 切换而不让线上域名下线。但 `DeletionPolicy` 没法只限定在那种场景,所以**整个栈被删时记录也留下**,域名继续指向一个已不存在的 distribution——`make delete` 之后必须手动清 Route53 记录。

(与 Change Set / Replace 的关系见 [CloudFormation-ChangeSet-and-Stack-Concepts.md](../notes/CloudFormation-ChangeSet-and-Stack-Concepts.md);DNS 切换见 [route53-oac-403-vs-404-dns-cutover-real-case.md](./route53-oac-403-vs-404-dns-cutover-real-case.md)。)

---

## 11. 排查工具箱:`profile` / `head-bucket` / `sts get-caller-identity`

### `The config profile (welby) could not be found`

意思:**本机 `~/.aws/config` 里没有叫 `welby` 的 profile**,命令连 AWS 都没连上。profile 名由每个人本机自己配置,Makefile 默认用 `welby`(`AWS_PROFILE ?= welby`),别人电脑上可能叫 `default` 或别的。

```bash
aws configure list-profiles     # 看本机有哪些 profile
make deploy ... AWS_PROFILE=default   # 用 ?= 的可覆盖性换 profile
```

`?=` 的意思:变量没设置时才用右边的默认值;命令行传了就用传的值。

### 验证桶存在 + 可读(只读,在任何目录都能跑)

```bash
$ aws s3api head-bucket --bucket cf-templates-rer3y5h4dn0v-us-east-1 --profile default
{
    "BucketArn": "arn:aws:s3:::cf-templates-rer3y5h4dn0v-us-east-1",
    "BucketRegion": "us-east-1",
    "AccessPointAlias": false
}
```

- 无报错 = 桶存在且可读;`403` = 存在但没权限;`404` = 不存在;"找不到 profile/凭证" = 本机没配好登录。
- **`head-bucket` 只证明"可读",不证明"可写"。**

### 验证"可写":传一个小测试文件(真实写操作,测完要删)

```bash
echo test > /tmp/write-test.txt
aws s3 cp /tmp/write-test.txt s3://cf-templates-rer3y5h4dn0v-us-east-1/write-test-delete-me.txt --profile default
aws s3 rm s3://cf-templates-rer3y5h4dn0v-us-east-1/write-test-delete-me.txt --profile default   # 清理(可能没有删除权限)
```

`aws s3 cp` 是**复制**,本地文件上传后依然在;`/tmp` 是临时目录,重启会被清,但手动 `rm` 更干净。

### 确认"我现在是哪个账号"

```bash
$ aws sts get-caller-identity --profile default
{ "UserId": "...", "Account": "649310177053", "Arn": "arn:aws:iam::649310177053:user/<你的用户名>" }
```

`Account` 对得上 Makefile 里的 `AWS_ACCOUNT_ID`(`649310177053`),说明本机 `default` 和部署用的是同一个账号。"开发者组权限相同"只是团队约定,这里验证的是"我自己的账号能读写",不是替别人验证。

### 顺带:macOS 的 `wc -c` 会补空格(已实测)

```
$ printf '[%s]\n' "$(wc -c < _deploy/cloudformation/lp.yml)"
[   51767]
$ printf '[%s]\n' "$(wc -c < _deploy/cloudformation/lp.yml | tr -d '[:space:]')"
[51767]
```

BSD `wc` 数字右对齐、前面补空格,GNU(Linux/CI)版直接输出数字。`[ -gt ]` 比较能容忍空格,但打印和做字符串匹配时会差一截,脚本里要用 `tr -d '[:space:]'` 去掉。

---

## 12. 实战排查方法论

1. **先读 PR 的 "Why / Validation"**:作者有没有真跑过(例:用 `--no-execute-changeset` 只预览不应用)。
2. **把"别人说的"和"我自己实测的"分开**:AI 审查员说 `make validate` 会坏,我们就真跑了一遍命令,拿到 `Member must have length less than or equal to 51200` 才写进评论;说"macOS wc 补空格"也在本机复现了。审查员"读代码得出"的结论(如 CI 路径过滤、negative control 逻辑)和"跑出来"的结论要在评论里措辞区分("コード上で確認")。
3. **先查真实参数,不要信仓库默认值**:profile 叫 `welby` 还是 `default`、桶在哪个 region、账号 ID 对不对,都用 `aws configure list-profiles` / `head-bucket` / `sts get-caller-identity` 实查。
4. **只读优先,写操作要清理**:`head-bucket`、`validate-template`、`get-caller-identity` 都是只读;必须验证写权限时只传一个一眼能认出来的小文件,用完删掉,并说明"这只证明我的账号能写"。
5. **新增检查器必须带 negative control**:一个从没被观察到失败过的检查,还不算检查。
6. **术语不懂就用比喻落地**:信封 vs 储物柜(inline vs S3)、总部 vs 门店(us-east-1 vs 边缘)、保安 vs 店员(WAF vs CloudFront)、便签迎宾员 vs 区域专员(CloudFront Functions vs Lambda@Edge)。

## SAA 考点速记

1. CloudFormation 模板:inline 51,200 字节 / S3 1MB(具体数字考的少,思路是"大了放 S3")。
2. CloudFront 是**全球服务**,管理入口在 `us-east-1`;给 CloudFront 用的 **ACM 证书**、**WAF(scope=CLOUDFRONT)** 必须在 `us-east-1`。
3. 内容由**边缘节点**就近分发,不是从美国返回。
4. WAF `REGIONAL` 保护 ALB/API Gateway 等,和资源同 region;`CLOUDFRONT` 在 us-east-1。
5. **Lambda@Edge**:us-east-1 创建、复制到边缘;日志写在**就近 region**。**CloudFront Functions**:轻量、更便宜、只处理 viewer 事件。
6. `DeletionPolicy: Retain`:删栈保留资源;Route 53 是全球服务。
7. 每个 region 至少 3 个 AZ;2019-03-20 之后新增的 region 需手动开启。
8. **NAT** = 网络地址转换(总机比喻),私有子网 IPv4 出网用 **NAT Gateway**;**IPv6 地址公网可路由**,出网且禁止外部主动连入用 **Egress-only Internet Gateway**(单向旋转门)。NAT Gateway 另有 NAT64 模式。
9. **DNS 记录**:A = 域名→IPv4;AAAA = 域名→IPv6。CloudFront 用 Route 53 ALIAS 时 A、AAAA 都可以。
10. **广播/多播/任播**:IPv6 没有广播;任播 = 一个地址对应多台机器、就近响应(如 Global Accelerator 的静态 IP)。
11. **CloudFront `IsIPV6Enabled=true` = 双栈**(IPv4 和 IPv6 都能进),不是仅 IPv6;访客真走 IPv6 还需要域名有 **AAAA 记录**。
12. **CNAME**:域名→另一个域名(转接牌),**裸域名上不能设**;**ALIAS**(Route 53 特有):前台代办,类型仍是 A/AAAA,**能用在裸域名**,只能指向 AWS 资源。
13. **www** 只是约定俗成的主机名,不是标准规定;Internet 是网络本身,Web 是跑在上面的一种服务。
14. **"自动跳转"是 HTTP 层(301/302)**,不是 DNS 的 CNAME/ALIAS;DNS 只负责"名字→地址",**不会改变浏览器地址栏**。Route 53 属 DNS 层,WAF / CloudFront Function / S3 属 HTTP 层。
