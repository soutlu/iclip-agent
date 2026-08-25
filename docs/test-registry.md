# iclip-agent 测试点登记表 (Test Registry)

> 本文档是 `docs/test-design.md` 中测试策略的具体执行映射表。随着系统演进，所有新增的自动化测试点和对应的边界风险都应在此登记。
> 实际已收集、已执行的用例以测试树目录与 CI 结果为准，不得仅凭本表宣称某项逻辑已经验证。

## 自动化测试矩阵

| ID | 层 (Layer) | 期望断言行为 (Behavior) | 预防风险 (Risk) |
|----|----|------|------|
| T-ARCH-01 | unit | tach 依赖图（相对导入同样解析）+ 框架围栏（pydantic_ai/pydantic_ai_harness/ag_ui/fastapi/sqlalchemy/fastapi-users/oss2 各归其位） | 分层腐蚀 |
| T-ARCH-02 | unit | 跨模块只准 import 对方 public.py；models/commands 只许 stdlib+common | 耦合扩散 |
| T-ARCH-03 | unit | 无静默 except fallback | 静默降级 |
| T-COLL-01 | unit | collection contract：越位测试文件被拒收；棘轮基线为空且无陈旧条目 | 测试树腐蚀 |
| T-CONFIG-01 | unit | 环境变量缺失 → 启动期报错，**缺几个报几个**且报的是变量名本身；空串与只有空白等于没设；连接串非 asyncpg、密钥过短即拒 | 静默降级 / 半配置难查 |
| T-CONFIG-02 | unit | YAML 未知字段 / 坏形状 → 拒绝（含旧写法的 `*_env` 键）；**仓里那份 `configs/config.yaml` 本身必须能被现在的模型加载**——留个过时键只会在真启动时炸 | 配置漂移 / 启动即挂 |
| T-AGENTCFG-01 | unit | `agents.yaml` **缺失即报错**（不降级成空注册表）；文件存在但内容空 / `agent: {}` → 空注册表；`spec` 解析为绝对路径、同目录 `instructions.md` 按约定挂上（缺则 None） | 静默降级 |
| T-AGENTCFG-03 | unit | agent 条目缺 `model` 即拒收（没有默认模型）；主从可各自指定模型 | 悄悄用了别的模型 |
| T-AGENTCFG-02 | unit | 未知字段（段内与顶层）、非 mapping 文档 → 拒绝；主/子 `spec` 文件不存在 → 启动期报错并指向声明位置 | 配置漂移 / 静默降级 |
| T-AGENTASM-01 | unit | 装配以 `name=<agent id>` 覆盖 spec 的 `name`（两个 id 指向同名 spec 仍可区分）；子 agent name 取自目录名 | 运行身份歧义 |
| T-AGENTASM-02 | unit | `instructions.md` 并入模型实际收到的指令；空白文件等价于「无提示词」，不注入空指令 | 提示词静默丢失/污染 |
| T-AGENTASM-03 | unit | 声明了 subagent 即挂上 `delegate_task` 且下属名进提示词 | 装配期冻结失效 |
| T-AGENTASM-04 | unit | 未注册 id → NotFound、请求体不合协议 → ValidationFailed，且两者都在返回事件流之前抛出 | 错误在流中途才暴露 |
| T-AGENTASM-05 | unit | 协议流路径真的落库：主 agent 与被派活下属各留一条 run，会话 id 取自请求体、`parent_run_id` 自动指向主 run | 运行事实只活在进程内存 |
| T-MEDIA-01 | unit | 媒体引用协议两个方向：入站视频/音频/文件只留一行自包含 tag（模型面不收字节）、图片是一对 tag 把一份缩到长边 1024 的像素包在中间、顺序与纯文本原样；内嵌 base64 按内容哈希落地（同一份字节重发落回同一个地址）；不可用的媒体（含缩放不了的图片地址）**原位**换成一句提示而不是被丢掉；缩不了的地址在 `resized_image_url` 本身是抛错而不是原样返回；出站一条 tag 连同它包住的像素与闭标签收成一个 part、还原出来的是 tag 里的原图地址 | 视频走到模型适配层才炸 / 同一张图每轮换身份 / 附件静默消失 / tag 漏给前端 |
| T-AGENTASM-07 | unit | 带附件的请求体在**协议入口**就换好形状：模型收到的是 tag（视频只有空 tag、图片的缩略像素被一对 tag 包着），媒体 part 到不了模型适配层 | 错误在流中途才暴露 |
| T-HIST-01 | unit | 历史的取材与过滤：取这段对话**最新的那份完整快照**（一份都没有就是空的，不是报错）；客户端塞进来的 system 消息不回传 | 提示词面外泄 / 刷新即丢历史 |
| T-MODEL-01 | unit | 命名模型装配：端点与 key 来自配置（含只收 api_key 的 provider 走 openai_client）；`api: responses` 显式分派且厂商 profile 不丢；有专属模型类的 provider（Ollama 等）不被拍平；未知 provider、responses 用在非 OpenAI 兼容 provider 上均装配期报错 | 静默走错端点 / 丢厂商适配 |
| T-MODELCFG-01 | unit | `models` 段：键名即模型名（`model` 字段只在起名时覆盖）；`api` 默认 chat、非法值即拒；声明了某模型但其 `api_key_env` 为空即启动报错 | 静默降级 |
| T-AGENTASM-06 | unit | agent / 子 agent 引用未声明的模型名即装配期报错；spec 里的 `model:` 被声明覆盖 | 模型声明双写打架 |
| T-AGENTAPI-01 | unit | `/agents/{id}/chat`：无主体 401、缺 `agent:run` 403、非 JSON content-type 415（且未派发运行）、未注册 id 404、坏 body 422、正常 200 + `text/event-stream` 首帧；续读端点同样要权限、运行 id 形状不合法 422、没有这次运行 404 | 越权 / CSRF / 错误映射 |
| T-AGENTAPI-04 | unit | 会话关卡与流名字：陌生会话 404 **且一帧都没派发**（核对必须在开流之前，否则只能在流中途爆开）；核对时「谁 / 哪个 agent / 哪段对话 / 哪次运行」四样都交出去；**同一个运行 id 换一段对话就是另一条流**（名字里少了会话那一段此断言即红）| 错误在流中途才暴露 / 两段对话串到一条流 |
| T-AGENTAPI-03 | unit | 每帧都带位置；带位置续读只拿之后的事件、不带位置整段重放；位置形状不合法在开流之前就 422；从末尾续读直接收流（不造中断事件）| 重连语义漂移 / 错误在流中途才暴露 |
| T-AGENTAPI-02 | unit | `OPTIONS /agents/{id}/chat` 返 204 且不含任何 `Access-Control-Allow-*` 头 | CSRF 防线被削弱 |
| T-OSS-01 | unit | 公开对象存储适配器：公网 URL 拼接与 key 编码、同 key 已存在即复用不重写、能逃出前缀的 key 一律拒、**不落在本服务命名空间下的 key 一律拒**（桶是公司共用的）、SDK 异常收成一种、公网前缀非 http 即启动报错；直传签名把 `Content-Type` 签进去且 key 里的 `/` 不转义；按前缀找对象时三项事实全取自桶，找不到即 `None`、一个前缀底下不止一个即报错 | 对象目录逃逸 / 落到别人的桶根上 / 桶里堆垃圾 / 客户端换类型偷传 |
| T-GEN-01 | unit | 生成请求只有一套定义：画幅/时长/分辨率/参考图上限、非 http URL 拒收、请求是 frozen 值；`model` 可选自由填（对方说了算，不维护白名单）而 `channel` 是封闭枚举，两者都进入入库快照；入库形状（camelCase、不存 `kind`）与读回走**同一条**校验路径，坏形状响亮失败不降级 | 持久化状态形状漂移 / 两套校验打架 |
| T-GEN-02 | unit | 视频接口协议映射：提交载荷与 X-API-Key、模型取自请求（缺省用配置默认）且实际用的记进快照、成功/失败/在跑三类状态、**没见过的状态即报错**、说成功却没给结果即报错；5xx 可重试而 4xx 不可 | 轮询到世界末日 / 静默降级 |
| T-GEN-03 | unit | 图像接口：文生图与图像编辑分派、结果转存成自己的公开对象、渠道取自请求并记进快照、**一次调用不重试也不换渠道**、没有轮询阶段 | 重复计费 / 悄悄改计费 / 链接过期 |
| T-GEN-04 | unit | 任务体的状态推进：调 provider 前先落 `submitting`；重跑时看见 `submitting` 即判失败且**一次都不重投**，收尾写入带状态守卫（不盖掉另一个进程带回的真结果）；已是终态的行不再提交；提交失败即终态（连可重试的也不重试）；在跑则按固定间隔重排（不逐次拉长）、问不通与不可重试各走各的；同步接口一步落终态时补齐对账 id 与 `submitted_at`，异步那条不改写原有 `submitted_at`；总时限兜底。排期只断言两处一错就没人发现的：**按生成类型排进各自的队列**、**失联 worker 手上的任务被捡回而活着的不动** | 重复计费 / 排错队列没人消费 / 任务永远躺着 |
| T-GEN-05 | unit | `/generations`：401/403、坏形状 422、202 只落 `pending` 不碰 provider、归属只取自主体、别人的 404、`users:manage` 看全部、响应不外泄 provider 快照；**排队失败时把那行判失败并把错误抛出去**（不留一个看起来还在排队的 `pending` 行） | 越权 / 客户端身份可信 / 内部字段外泄 / 永远没人做的行 |
| T-GENCFG-01 | unit | `media_generation`：`VIDEO_SUBMIT_URL` 为空即整项关闭；开了则其余 env 都必需，缺一个即启动报错并指向变量名。**对象存储是自己的开关**（`OSS_BUCKET` 为空即整项关闭），开了则其余 OSS 变量必需；生成开着而桶没开是半开着，启动即报错 | 半开着的能力 / 静默降级 / 库里存一批会过期的地址 |
| T-PROD-01 | unit | 码→名字三张对照表：认得的翻译成人话；**不认得的保留码、名字给 null**（不由别的字段推一个出来）；上游那一格为空时整块为 null | 猜出来的名字流到界面上 |
| T-PROD-02 | integration_no_llm | `/products/{styleNo}`：401、查不到 404、上游标记删除的款不可见；响应里码与名字分开、`styleWms` 带出来、`combatTeam` 为 null；图片地址由前缀+object key 拼成（前缀末尾的斜杠要吃掉）；四条过滤各挡一种脏数据（非当前版本、转存失败、源端已删、非产品图类型、挂在别的款上）且同图去重；一个颜色挂在多个 SKC 上只出现一次；款有但图色为空仍是 200 | 拼出裂图地址 / 把脏数据当有效资料返回 |
| T-PRODCFG-01 | unit | `PRODUCT_CATALOG_DATABASE_URL` 为空即整项关闭（这项能力没有 YAML 段）；配了就必须一起配 `PRODUCT_IMAGE_BASE_URL`，缺了启动报错并指向变量名；没配时路由整组不挂载（断言落在路由表上——没挂载和查不到都是 404，从响应上分不出来）| 半开着的能力 / 装配期漏装 |
| T-INSP-01 | integration_no_llm | `/inspirations/videos/search`：401、无匹配返回空列表（不是 404）；指标、三个爆款标记、CT 与平台类目原样带出，钱是字符串；没有转存副本时 `ossUrl` 为 null 但原始地址仍在；**top-N 在库里取**（换排序维度换的是样本，不是本地重排）；别的款的视频不返回；排序维度是封闭枚举（注入串 422）；款号条数与 limit 的上下界；没配爆款库时路由整组不挂载 | 按错编码静默返空 / 应用层排序换样本 / 排序键直达 SQL |
| T-INSPCFG-01 | unit | `INSPIRATION_DATABASE_URL` 为空即整项关闭（这项能力没有 YAML 段）；配了即解析出连接 | 半开着的能力 |
| T-GENBOOT-01 | unit | 没开生成则 `/generations` 整组 404；开了则挂上（未认证 401 而非 404）；半配置在启动期失败 | 装配期漏装 |
| T-GENBOOT-02 | integration_no_llm | 开着生成时整个 app 的 lifespan 真的跑一遍：队列连接开得上、三个 worker 起停都干净、路由还在 | 启动即挂 / 关停卡住进程 |
| T-GEN-06 | integration_no_llm | 真库上的事实：时刻由数据库时钟写、整条状态链往返 + 请求体读回一致、同步结果补齐 `submitted_at`；**状态守卫**放行与落空各一条（`WHERE` 里的守卫是原子的，内存替身模拟不了）；归属收敛与属主删除级联 | 覆盖掉已付费的成功 / 归属越界 |
| T-GEN-07 | integration_no_llm | 真库上的排期，验的是装配：DSN 换驱动、迁移与库版本合得上、进程内起 worker 能把活干完——同步与异步两条链全自动跑到终态；发版打断提交后重跑，守卫判 `SUBMIT_INTERRUPTED` 且 **provider 一次都没被再调**；硬杀那一种靠心跳发现（心跳新鲜时谁都不许动它） | 单测全绿而线上一个任务都不动 / 重复计费 |
| T-RBAC-01 | unit | 预置角色投影（root/editor/viewer 全断言，root=全量计算）；有效权限=角色并集∪直接授权；未知角色零权限；`api_keys:issue` 仅 root | 越权 |
| T-KEY-01 | unit | key 生成格式 `iclip_sk_`、哈希与前缀派生；签发需 `api_keys:issue`；授予集 ⊄ 签发者权限 → 拒绝；key 主体不能签发 key | 凭证泄露/越权 |
| T-AUTH-01 | integration_no_llm | 注册（默认 viewer）→ 登录（204 + Set-Cookie）→ `GET /users/me`（{user:{...}} 信封、permissions 投影） | 主链路 |
| T-AUTH-02 | integration_no_llm | 未认证 401；登出清 cookie；username 或 email 均可登录 | 认证边界 |
| T-KEY-02 | integration_no_llm | 创建 key（明文仅一次）→ Bearer 调用受保护端点 → 吊销后 401 | 双主体主链路 |
| T-KEY-03 | integration_no_llm | key 有效权限=显式授权集，属主角色变化不影响；属主停用后 401 | key 权限语义 |
| T-KEY-04 | integration_no_llm | DB 中无明文 token（只有哈希 + 前缀）；列表只返回前缀 | 凭证泄露 |
| T-SSO-01 | integration_no_llm | authorize 返回带 redirect_uri/_fromApp 的跳转 URL；SSO 关闭时整组路由 404 | SSO 契约 |
| T-SSO-02 | integration_no_llm | callback：verify → PMS 资料 → 首登建号（editor）→ Set-Cookie；再登复用同一账号并同步资料 | SSO 契约 |
| T-SSO-03 | integration_no_llm | PMS 失败 → callback 显式失败，不建号不发 cookie | 静默降级 |
| T-SSO-04 | integration_no_llm | 同邮箱既有账号首次 SSO 登录：只关联身份，不重置 roles/直接授权（资料字段照常同步） | 身份提供方改写授权 |
| T-WS-01 | integration_no_llm | WS 握手 principal 解析：cookie（同源/白名单/非法 Origin 拒 1008）与 Bearer 各分支 | 双主体传输无关 |
| T-USERS-01 | integration_no_llm | `GET /users` / `PATCH /users/{id}` 仅 users:manage；调整角色/直接授权即时生效；不能改自己的授权或停用自己 | 越权 |
| T-MIG-01 | integration_no_llm | alembic upgrade head 于 scratch 环境成功；`iclip` schema 下的**全部**表与各模块 ORM 元数据的并集零漂移（在该 schema 里加表的模块必须把元数据加进测试的 `_MODULE_METADATA`）；`agent_runtime` 的表不在断言内，往该 schema 加表须人工 `make db-upgrade` 确认 | 迁移漂移 |
| T-STORE-01 | integration_no_llm | PG step store 满足官方 `StepStore` / `MediaStore` 协议；register 单发、list_runs 排序与过滤、快照 complete/interrupted 读门、保留集裁剪、tool_effects upsert | 与官方语义漂移 |
| T-STORE-02 | integration_no_llm | 真实 Agent（FunctionModel）挂官方 StepPersistence 跑通：运行/事件/工具账落库，续跑历史与 `all_messages()` 解析成 JSON 后结构一致 | 运行历史不可续 |
| T-STORE-03 | integration_no_llm | 消息负载无损往返：含 `NUL(\u0000)` 转义的文本、≥64KiB 媒体外置与还原 | 存储层静默损坏 |
| T-AGENTRUN-01 | integration_no_llm | 真实 app + 真实用户：匿名 401、viewer 403、editor 跑通 `test` 模型 200 流；未注册 id 404、非 JSON 415、坏 body 422、OPTIONS 不放行；自己编的会话 id、别人的会话 id、以及**同一个 id 的大写写法**都是 404（大写解析出的是同一个 UUID，但下游用的是原样字符串，放行它会长出第二个工作区和第二条流）；跑过一次之后对话上记着 `lastRunId`，且客户端铸造的运行 id 被盖进了落库的消息里 | 双主体与 agent 运行面的联动 / 客户端自造会话 / 两套 id 事后对不上 |
| T-TASK-01 | unit | `/tasks` 的权限、状态机与冻结规则：401/403、坏形状 422、创建者只取自主体（请求体里给就 422）、**人人看得见全部**（不做归属过滤）、草稿只有创建者或治理者能改能删（看得见但不让改是 403 不是 404）、发布要有期限且 brief 得说清做什么、**下发之后动了冻结的创作输入是 409 而补充字段照常能改**、十种流转组合走不通的一律 409、只有草稿能删、撤回之后彻底改不动；**款号快照由服务端抄、之后改不动**（PUT 带 `styleNo` 或 `style` 是 422），`brief.styleNos` 首位必须是主款（不给就补回来，给错 422），款号全集下发后也冻结 | 冻结形同虚设 / 越权改别人的草稿 / 错误映射 / 封面与详情各说一个款 |
| T-TASK-02 | integration_no_llm | 真库上的事实：建→发→确认→撤回整条链走通、brief 存进去读回来是同一份（含没填字段的空值）、**时刻与「期限还没到」的比较都由数据库的钟做**（过期的草稿发不出去）、**状态守卫是原子的**（读到写之间被人撤回，这次改动落空并 409——内存替身模拟不了）、款号快照存进去读回来是同一份（入库就是 camelCase 那一份）、四条 CHECK 真的在表上、创建者用 restrict 挡住静默删除、viewer 看得见别人的但改不动 | 应用进程的钟决定成败 / 基于过期认知的写入 / 约束只写在 Python 里 |
| T-PROJ-01 | integration_no_llm | `/projects` 与两处归属在真库上的事实：401/403、viewer 读得到但开不了、开→读→改名→删走通；**项目人人可见**（换个人看得见、改名也做得了），但删除只有开它的人或治理者能做（403 不是 404）；开对话时两处归属可以都空着（直接创作）、也可以各带一个，**编一个不存在的 id 由外键挡下来翻成 422**；会话在项目之间搬得动、也拿得出来（给 `null`）；**会话挂的项目不必是它那张单挂过的**（默认值不是围栏）；**删项目、删单都只把会话上那一列置空、不带走会话**（写在表上的 SET NULL，替身测不出来）；单挂项目是整体覆盖且给重了会去重、给不存在的项目 422；一张单下面的尝试按开始时间正序，且**只列自己的**（单人人可见 ≠ 谁跑过什么人人可见） | 删口袋带走东西 / 归属校验变成围栏 / 一张单下别人的尝试泄露 / 约束只写在 Python 里 |
| T-ASSET-01 | unit | `/uploads/sign` 与 `/assets` 的权限与登记规则：401/403、不收的类型在签名前就 422、**签名只发名字不落行**（拿了地址不传，账本里没有它，读它是 404）、签出去的 key 由 assetId 派生且类型一起签进签名、登记的事实（真实 key、大小、类型、公网地址）全部来自桶、还没传上来就登记是 409、重复登记返回同一行、超限的只进桶不进账本、**人人看得见全部**（`creatorUserId` 只是查询维度）、地址是按 key 拼的不是存的；**图片尺寸在签名那一步就卡**（短边 <300 或长边 >6000 一律 422，横竖同一把尺子，边界值本身放行；传图不报宽高是 422，传视频不用报） | 客户端自报事实 / 传上去的东西没人认领 / 重试建出两份 / 越权 / 不合格的图先传上来再说 |
| T-ASSET-02 | integration_no_llm | 真库上的事实：签名→直传→登记→读回来整条链在真装配的 app 上走通、**登记时刻由数据库的钟写**、`object_key` 唯一约束真的在表上（同一个对象登记不成两份）、创建者用 restrict 挡住静默删除、换个人登录看得见别人传的素材、没配桶时这两组路由整个不挂载 | 应用进程的钟决定成败 / 约束只写在 Python 里 / 半开着的能力 |
| T-ASSET-03 | unit | `POST /assets/import`：字节搬进我们的桶、回的是我们自己的地址（外部地址进不了账本）；**源地址算 id**，同一个地址第二次连请求都不发、只有一行；尺寸是量出来的（太小太大都 422 且桶里账本里都不留东西）、不收的类型 422、**3xx 不跟随**、取不回来 422、视频不卡尺寸、只读权限进不来 | 外链烂掉 / 同一张图搬一堆份 / 听客户端报尺寸 / 被借去搬任意地址 |
| T-CONV-01 | integration_no_llm | `/conversations` 全链路：匿名 401、viewer 建不了（但列表可读）、开→列→改名→删走通，id 由服务端发放、`lastRunId` 初始为空、列表按最近活动倒序（改名也算活动）；别人的对话列表里没有、改名与删除都 404；不存在的 id 404；坏 payload 422 | 越权 / 会话归属泄露 |
| T-CONV-03 | integration_no_llm | `GET /conversations/{id}/messages`：发出去是媒体 part、读回来还是媒体 part（中间那副 tag 形状不外露），喂过模型的缩略图不回传；一次运行都没跑过是空列表；别人的对话 404 | 刷新即丢历史 / tag 漏给前端 / 历史响应驮着一堆图 |
| T-CONV-02 | integration_no_llm | 删对话把这段对话的工作区文件一并删掉，且**只删这一段**（另一段对话的文件还在）——两张表之间没有外键，这条连带关系断了不会报错，只会留下再没人看得见的文件 | 删不干净 / 删过头 |
| T-SKILL-01 | unit | 声明的 skill 名不在库里 → 装配期报错；声明了 skill 却没有库目录 → 加载期报错；空列表与不写同义（都不挂、也不要求库存在）；库与 `get_skill_reference` 成对挂载 | 静默降级成「没挂」 |
| T-WORKSPACE-01 | unit | 路径语法（`..`/绝对路径/反斜杠/控制字符/超长超深一律拒；`//` 与首斜杠规范化；Unicode 两种写法归一成同一文件）；命名空间是 `{user}/{conversation}`、deps 不对时 `for_run` 即失败（不退回公共命名空间）；同一用户两段对话互不可见；**下属写、主 agent 读回来走同一个文件夹**（改成读 `ctx.conversation_id` 此断言即红）；六件工具的行为与错误翻译（读不到/读越界/`old_text` 零次或多次匹配/删不存在/配额两种上限各自的自救提示）；`list` 按段边界限定；检索大小写不敏感且 `%` 为字面量、少报要标注；**取地盘走 `FileSpace.resolve()` 而不是规则的原样值**（绕开即红——绕开不报错，只让收同一个 `FileSpace` 的另一件能力算出别的字符串）；能力 id 写死、`get_serialization_name()` 为 None；**挂到真 Agent 上跑通**（六件工具都到模型面前、文件落进发起方的命名空间） | 越界访问 / 静默改错地方 / 静默少给 / 装配面接不上 |
| T-WORKSPACE-03 | unit | `FileSpace.resolve()`：命名空间自己也过路径语法（`//` 与首斜杠规范化；`..`/`.`/空/尾斜杠一律拒）；规则自己抛就让它抛，不吞掉退回公共命名空间 | 两个调用方算出不同的地盘 / 隔离根是纸做的 |
| T-WORKSPACE-02 | integration_no_llm | `PgFileStore` 对真库：生成列 `size_bytes` 与内容一致；CAS 报出实际版本、对已删文件报冲突而非静默新建；NUL 字节在驱动之前被拒；**并发写不同路径时命名空间配额仍关严**（预热连接池后两个写真交错，摘掉 advisory 锁此断言即红）；覆盖只算差量；列目录按码位序（显式 `COLLATE "C"`，不吃服务器 locale）与段边界；命名空间互不可见 | 配额被并发撑爆 / 排序随部署漂移 / 静默重建 |
| T-SKILL-02 | unit | `get_skill_reference`（经真 Agent 调用）：授权 skill 的 `.md` 读得到；没挂载的 skill、越界路径（`..`/绝对路径）、非 `.md`、不存在 → 可重试提示且报出有哪些文件；超上限截断且显式标注；编码坏了直接失败不重试 | 越权读别人的 references / 静默少给一段 / 模型在重试上打转 |
| T-DEPS-01 | unit | `start` 收到的 deps 一路进到工具的 `ctx.deps`（协议面与官方 `override(deps=…)` 两条路各验一次）| 工具拿不到宿主依赖 |
| T-DEPS-02 | integration_no_llm | 完整 HTTP 路径：工具拿到的是发起这次运行的主体；两个用户各跑一次，各拿自己的主体 | 身份串人 / deps 被装配期捕获 |
| T-SKILL-03 | integration_no_llm | 完整 app 跑一次运行：声明里挂的 skill 真的到达那个 agent（模型看得到官方 `load_capability` 与 `get_skill_reference`）| 声明→运行的翻译被删掉后无声丢失 SOP |
| T-PACK-01 | unit | 能力包按名字解析；名字没登记 → 装配期报错（错误里列出已登记的）；没声明即不挂 | agent 带着半套工具上线 |
| T-SUBAGENT-01 | unit | 子 agent 只拿到声明给它的能力：主 agent 的能力包工具不出现在下属的工具集里，反之亦然 | 能力经继承隐式扩散 |
| T-BOOT-01 | unit | 声明了 agent 却没配 `redis` 段 → 启动即报错；没声明 agent 则整组 agent 路由不挂（请求 404），也不需要 Redis | 静默降级 |
| T-STREAM-01 | integration_no_llm | 真 TCP 断开（uvicorn）：读到一半断线后运行继续跑完，续读能看到断开之后才产生的内容与正常终态，完整快照照样落库 | 断开即白跑 |
| T-STREAM-02 | integration_no_llm | 真 Redis 上带 `Last-Event-ID` 续读只补发之后的事件；换个用户拿同一个运行 id 一律 404 | 重放错位 / 越权读别人的运行 |
| T-STREAM-03 | integration_no_llm | 过了重放窗口带位置来续读 → 显式拒绝（不默默跳到当前位置）；不带位置 → 404 | 无声接不上 |
| T-STREAM-04 | integration_no_llm | 生产者存活标记过期且流无终态 → 读的人把可重试的 `RUN_ERROR` 写进流收尾，后来的读者看到同一个结局，且这条流也拿到重放窗口 | 伪造终态 / 读者干等 / 键永不过期 |
| T-STREAM-05 | integration_no_llm | 跑完之后同一个运行 id 再发起一次：流的长度一帧不多（断言不能比对读到的事件——重复的帧落在终帧之后，读不到）| 重跑一遍白烧模型调用 |
| T-CONFIG-03 | unit | `redis` 段：配了就必须有 `REDIS_URL`（缺了报出变量名）、默认值显式、缺段即无事件流 | 静默降级 |
| T-AGENTRUN-02 | integration_no_llm | 完整 HTTP 路径跑一次运行后，`agent_runtime.runs` 有对应会话的 run（id 前缀为 agent id），`agent_runtime.events` 首帧为 `run_started` | 运行事实只活在进程内存 |
| T-MATERIAL-01 | unit | 素材范围只由模型请求那一侧算出：用户附件的 tag 给出种类、agent 指令与 system 消息算数；**模型正文与工具调用参数一律不算**（自己给自己发通行证）、`RetryPromptPart` 不算（回显即洗白）；工具产出的地址算数但没有种类——dict/list 返回被序列化成 JSON 后 tag 带转义引号扫不出来，纯字符串返回（`read_file`）则连种类一起认得回来；图片只认 tag 里的原图地址，喂厂商的缩略档不算（模型读不到它）；合法地址的**前缀**能过是已知取舍 | 模型凭空捏造地址 / 洗白通道 / 把没看过的地址当成抄得到的 |
| T-MATERIAL-02 | unit | 四件工具的素材范围：拆片与取帧只收声明为视频的地址，编造的地址被拒且**报错里列出本对话真有的视频、不回显被拒地址**；用户发的图当参考片、参考片地址当参考图都按种类拒掉；`ReadMediaFile` 收工具结果 JSON 里的裸地址（没有 tag 也算），没出现过的同域地址仍被拒 | 让服务器去下载编造的地址 / 为编造的参考图付一次生成的钱 |
| T-SHOT-01 | unit | 切格几何（纯函数）：PGM 解析的七类坏输入各自被拒；分隔带不在等分线上时按它切、外圈边框另修；**检测不到时退回等分且 `detected` 为假**（只量到一个轴也算没量到）；离等分线太远的白带不当网格线；黑色格间距同样算；行列数越界、像素长度对不上即拒；画幅收缩在容差内不动、大偏差照常裁（那是正常操作）、空盒即拒；缩放坐标还原 | 静默切歪 / 把错误整形成「看起来对」 |
| T-SHOT-02 | unit | 六件工具的语义（出图/对象存储/拆解/文件存储都用替身）：能力 id 写死、`get_serialization_name()` 为 None、`get_instructions()` 为 None（接力顺序归 skill，不由能力包注入）、六件工具都到模型面前；deps 不是 `AgentRunDeps` → 直接炸而不是可重试提示；**写出去的文件落在规范化之后的地盘**（绕开 `resolve()` 即红，那正是模型的 `read_file` 看不见这些文件的成因）；拆解文档写进工作区、只回路径，取帧与拆片各自算出的路径落在同一份文件上；同名视频不共用一份文档；非 http 地址在碰网络之前被拒；拆解失败翻成可重试提示 | 越界输入 / 装配面接不上 / 两边看不见同一份文件 |
| T-SHOT-03 | unit | 逐格请求的校验与出图的重试升级：没有取帧账本即指向 `plan_shot_frames`；帧号形状错、不在账本里、同批重复、prompt 为空、条数不在 1-4 **都在提交之前**被拒（一次都没提交）；整版按 `4k` 提交且空格由中性面板补满；`PROVIDER_UNREACHABLE` 与 `PROVIDER_SERVER_ERROR` 才自动再发，dev 试满再升 pro（渠道序列 dev,dev,pro）；**`PROVIDER_RESULT_UNKNOWN` / `PROVIDER_REJECTED` / `OUTPUT_*` / `SUBMIT_INTERRUPTED` / `PROVIDER_TIMEOUT` 一次都不重发**；画幅不合规在提交之前拒；等超时也要把记录 id 报回去 | 重复计费 / 悄悄改计费 / 一次生成没有结论 |
| T-SHOT-04 | integration_no_llm | 真起 ffmpeg（素材由 ffmpeg 自己合成，经替身传输喂进去）：切格真按非等分的网格线走（四格实际像素尺寸各不相同，等分切法给不出这个结果），图比检测宽度大时坐标按比例还原回原图；整片按秒抽帧的栅格是全片统一的（镜头 1 拿 0/1000ms、镜头 2 拿 2000ms → `S1-1`/`S1-2`/`S2-1`），拼板落公开地址、账本落工作区，同一视频同一份文档第二次直接复用不重抽；越界时间码报出实际时长；出图收敛后真切格、只留请求的那几格、版记录逐帧带 prompt；补拍同样真切格、只留请求的那几格、版记录逐格带描述；整图取不回来是失败而不是空结果；`ReadMediaFile` 真把画面附在结果里 | 几何只在纸面上对 / 重复抽帧与重复计费 / 下载失败炸成 500 |
| T-SHOT-05 | unit | 补拍设定图与交付镜头组：`cells` 条数不在 1-4、某格描述为空**都在提交之前**被拒（一次都没提交）；补拍不带参考图、按方版最高档提交、空格由中性面板补满、失败时给的是空的 `images` 而不是空的 `frames`；交付整份校验——`index` 不从 1 连续、prompt 为空、`seconds` 不在 4-30、`image_urls` 为空、地址不是 `generate_shot_frames` 生成过的、prompt 里写到的 `@ImageN` 超出这一组张数、画幅不合规，**任一条都整份拒收且工作区里不留半份文件**；一帧都还没生成时报的是「去 `frames/grids/` 找地址」而不是「地址不对」 | 编造帧地址 / 半份产物 / 重复计费 |
| T-SHOTCFG-01 | unit | `shot_video`：`VIDEO_UNDERSTANDING_URL` 为空即整项关闭（段留着也一样）；开了则 key 必需（缺了报变量名）；**开了但媒体生成没开即启动报错**（出图与对象存储都走生成那一套）；模型名来自 YAML | 半开着的能力 / 静默降级 |
| T-SHOTBOOT-01 | unit | 依赖不齐时 `shot_video` 不进名字表，引用它的 agent 在装配期报「未登记的 capability」；依赖齐了才登记得上；**挂了 `shot_video` 没挂 `workspace` 在装配期报错指向 `agents.yaml`**（两边共用同一个存储与命名空间规则，少挂一个的失效是静默的：文档照写照读，只是模型看不见）；适配器把不合规的画幅/档位翻成能力包自己的错误类型（不外泄领域错误） | agent 带着半套工具上线 |
| T-ADMIN-01 | integration_no_llm | root 引导：`ROOT_EMAIL` SSO 登录即持有 root；CLI set-roles 直连 DB（非 SSO 场景） | 引导链路 |
