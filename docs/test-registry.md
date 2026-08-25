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
| T-MODEL-01 | unit | 命名模型装配：端点与 key 来自配置（含只收 api_key 的 provider 走 openai_client）；`api: responses` 显式分派且厂商 profile 不丢；有专属模型类的 provider（Ollama 等）不被拍平；未知 provider、responses 用在非 OpenAI 兼容 provider 上均装配期报错 | 静默走错端点 / 丢厂商适配 |
| T-MODELCFG-01 | unit | `models` 段：键名即模型名（`model` 字段只在起名时覆盖）；`api` 默认 chat、非法值即拒；声明了某模型但其 `api_key_env` 为空即启动报错 | 静默降级 |
| T-AGENTASM-06 | unit | agent / 子 agent 引用未声明的模型名即装配期报错；spec 里的 `model:` 被声明覆盖 | 模型声明双写打架 |
| T-AGENTAPI-01 | unit | `/agents/{id}/chat`：无主体 401、缺 `agent:run` 403、非 JSON content-type 415（且未派发运行）、未注册 id 404、坏 body 422、正常 200 + `text/event-stream` 首帧；续读端点同样要权限、运行 id 形状不合法 422、没有这次运行 404 | 越权 / CSRF / 错误映射 |
| T-AGENTAPI-03 | unit | 每帧都带位置；带位置续读只拿之后的事件、不带位置整段重放；位置形状不合法在开流之前就 422；从末尾续读直接收流（不造中断事件）| 重连语义漂移 / 错误在流中途才暴露 |
| T-AGENTAPI-02 | unit | `OPTIONS /agents/{id}/chat` 返 204 且不含任何 `Access-Control-Allow-*` 头 | CSRF 防线被削弱 |
| T-OSS-01 | unit | 公开对象存储适配器：公网 URL 拼接与 key 编码、同 key 已存在即复用不重写、能逃出前缀的 key 一律拒、SDK 异常收成一种、公网前缀非 http 即启动报错 | 对象目录逃逸 / 桶里堆垃圾 |
| T-GEN-01 | unit | 生成请求只有一套定义：画幅/时长/分辨率/参考图上限、非 http URL 拒收、请求是 frozen 值；`model` 可选自由填（对方说了算，不维护白名单）而 `channel` 是封闭枚举，两者都进入入库快照；入库形状（camelCase、不存 `kind`）与读回走**同一条**校验路径，坏形状响亮失败不降级 | 持久化状态形状漂移 / 两套校验打架 |
| T-GEN-02 | unit | 视频接口协议映射：提交载荷与 X-API-Key、模型取自请求（缺省用配置默认）且实际用的记进快照、成功/失败/在跑三类状态、**没见过的状态即报错**、说成功却没给结果即报错；5xx 可重试而 4xx 不可 | 轮询到世界末日 / 静默降级 |
| T-GEN-03 | unit | 图像接口：文生图与图像编辑分派、结果转存成自己的公开对象、渠道取自请求并记进快照、**一次调用不重试也不换渠道**、没有轮询阶段 | 重复计费 / 悄悄改计费 / 链接过期 |
| T-GEN-04 | unit | 任务体的状态推进：调 provider 前先落 `submitting`；重跑时看见 `submitting` 即判失败且**一次都不重投**，收尾写入带状态守卫（不盖掉另一个进程带回的真结果）；已是终态的行不再提交；提交失败即终态（连可重试的也不重试）；在跑则按固定间隔重排（不逐次拉长）、问不通与不可重试各走各的；同步接口一步落终态时补齐对账 id 与 `submitted_at`，异步那条不改写原有 `submitted_at`；总时限兜底。排期只断言两处一错就没人发现的：**按生成类型排进各自的队列**、**失联 worker 手上的任务被捡回而活着的不动** | 重复计费 / 排错队列没人消费 / 任务永远躺着 |
| T-GEN-05 | unit | `/generations`：401/403、坏形状 422、202 只落 `pending` 不碰 provider、归属只取自主体、别人的 404、`users:manage` 看全部、响应不外泄 provider 快照；**排队失败时把那行判失败并把错误抛出去**（不留一个看起来还在排队的 `pending` 行） | 越权 / 客户端身份可信 / 内部字段外泄 / 永远没人做的行 |
| T-GENCFG-01 | unit | `media_generation`：`VIDEO_SUBMIT_URL` 为空即整项关闭；开了则其余 env 与 `object_store` 段都必需，缺一个即启动报错并指向变量名 | 半开着的能力 / 静默降级 |
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
| T-AGENTRUN-01 | integration_no_llm | 真实 app + 真实用户：匿名 401、viewer 403、editor 跑通 `test` 模型 200 流；未注册 id 404、非 JSON 415、坏 body 422、OPTIONS 不放行 | 双主体与 agent 运行面的联动 |
| T-SKILL-01 | unit | 声明的 skill 名不在库里 → 装配期报错；声明了 skill 却没有库目录 → 加载期报错；空列表与不写同义（都不挂、也不要求库存在）；库与 `get_skill_reference` 成对挂载 | 静默降级成「没挂」 |
| T-WORKSPACE-01 | unit | 路径语法（`..`/绝对路径/反斜杠/控制字符/超长超深一律拒；`//` 与首斜杠规范化；Unicode 两种写法归一成同一文件）；命名空间是 `{user}/{conversation}`、deps 不对时 `for_run` 即失败（不退回公共命名空间）；同一用户两段对话互不可见；**下属写、主 agent 读回来走同一个文件夹**（改成读 `ctx.conversation_id` 此断言即红）；六件工具的行为与错误翻译（读不到/读越界/`old_text` 零次或多次匹配/删不存在/配额两种上限各自的自救提示）；`list` 按段边界限定；检索大小写不敏感且 `%` 为字面量、少报要标注；能力 id 写死、`get_serialization_name()` 为 None；**挂到真 Agent 上跑通**（六件工具都到模型面前、文件落进发起方的命名空间） | 越界访问 / 静默改错地方 / 静默少给 / 装配面接不上 |
| T-WORKSPACE-02 | integration_no_llm | `PgWorkspaceStore` 对真库：生成列 `size_bytes` 与内容一致；CAS 报出实际版本、对已删文件报冲突而非静默新建；NUL 字节在驱动之前被拒；**并发写不同路径时命名空间配额仍关严**（预热连接池后两个写真交错，摘掉 advisory 锁此断言即红）；覆盖只算差量；列目录按码位序（显式 `COLLATE "C"`，不吃服务器 locale）与段边界；命名空间互不可见 | 配额被并发撑爆 / 排序随部署漂移 / 静默重建 |
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
| T-SHOT-01 | unit | 切格几何（纯函数）：PGM 解析的七类坏输入各自被拒；分隔带不在等分线上时按它切、外圈边框另修；**检测不到时退回等分且 `detected` 为假**（只量到一个轴也算没量到）；离等分线太远的白带不当网格线；黑色格间距同样算；行列数越界、像素长度对不上即拒；画幅收缩在容差内不动、大偏差照常裁（那是正常操作）、空盒即拒；缩放坐标还原 | 静默切歪 / 把错误整形成「看起来对」 |
| T-SHOT-02 | unit | 四件工具的语义（出图/对象存储/拆解都用替身）：能力 id 写死、`get_serialization_name()` 为 None、`get_instructions()` 为 None（接力顺序归 skill，不由能力包注入）、四件工具都到模型面前；deps 不是 `AgentRunDeps` → 直接炸而不是可重试提示；非 http 地址、时间码六类坏写法、超过每次 8 帧、行列数越界**都在碰网络与子进程之前**被拒；拆解失败翻成可重试提示 | 越界输入 / 装配面接不上 / 白跑一次下载 |
| T-SHOT-03 | unit | 出图的重试与升级：一次成功只提交一次；`PROVIDER_UNREACHABLE` 与 `PROVIDER_SERVER_ERROR` 才自动再发，dev 试满再升 pro（渠道序列 dev,dev,pro）；**`PROVIDER_RESULT_UNKNOWN` / `PROVIDER_REJECTED` / `OUTPUT_*` / `SUBMIT_INTERRUPTED` / `PROVIDER_TIMEOUT` 一次都不重发**；参数不合规在提交之前拒（一次都没提交）；等超时也要把记录 id 报回去；试过几次要出现在结果里 | 重复计费 / 悄悄改计费 / 一次生成没有结论 |
| T-SHOT-04 | integration_no_llm | 真起 ffmpeg（素材由 ffmpeg 自己合成，经替身传输喂进去）：切格真按非等分的网格线走（四格实际像素尺寸各不相同，等分切法给不出这个结果）、目标画幅收缩落到像素上、切完与抽完的画面都附在结果里；按时间码抽帧尺寸正确；超出时长的时间码报出实际时长；取不到素材翻成可重试提示 | 几何只在纸面上对 / 下载失败炸成 500 |
| T-SHOTCFG-01 | unit | `shot_video`：`VIDEO_UNDERSTANDING_URL` 为空即整项关闭（段留着也一样）；开了则 key 必需（缺了报变量名）；**开了但媒体生成没开即启动报错**（出图与对象存储都走生成那一套）；模型名来自 YAML | 半开着的能力 / 静默降级 |
| T-SHOTBOOT-01 | unit | 依赖不齐时 `shot_video` 不进名字表，引用它的 agent 在装配期报「未登记的 capability」；依赖齐了才登记得上；适配器把不合规的画幅/档位翻成能力包自己的错误类型（不外泄领域错误） | agent 带着半套工具上线 |
| T-ADMIN-01 | integration_no_llm | root 引导：`ROOT_EMAIL` SSO 登录即持有 root；CLI set-roles 直连 DB（非 SSO 场景） | 引导链路 |
