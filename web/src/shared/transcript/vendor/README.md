# vendor：kimi code 的 transcript 数据层

照抄来的外部合同，出处：

- 包：`@moonshot-ai/transcript` 0.0.2（MIT，见 `LICENSE`）
- 仓库：https://github.com/MoonshotAI/kimi-code，目录 `packages/transcript`

**这个目录不改，要改改外面。** 它是我们与协议之间那份逐字一致的凭据：服务端发的每一帧都按
`contract/schema.ts` 里的 zod 校验，改一个字母就整帧被拒。适配、封装、状态管理一律放在
`../` 下面。

上游的两份测试也一并带来（`__tests__/`），它们是「没改坏」的免费证明。

## 做过的改写

上游用 `#/x` 这种包内路径引用自己（靠 package.json 的 `imports` 字段解析），vendor 之后没有
那个字段，所以测试里的 `from '#/x'` 机械改成了相对路径。`src` 那些文件本来就用相对路径，一个
字没动。

工具帧上多一个 `metadata`（`contract/schema.ts` 与 `model/frame.ts` 各一处）：kimi 的帧没有它，
这是本仓的扩展——工具返回里给人看的那份结果原样落在这个字段上，不写进 schema 会被 zod 丢掉。

轮头部与用户文本块带 `content`（`contract/schema.ts`、`model/turn.ts`、`model/frame.ts`）：用户消息的
原样 part 列表，与发消息接口的 `content` 同形。kimi 的轮头部是 `prompt` 字符串加附件 id 列表，本仓
不用那两个字段，附件实体表（`attachment.upsert`）也不再发；`ops/apply.ts` 里比对轮头部与用户块
的那两处随之改看 `content`。

上游的 `history/`（从 kimi 的消息记录冷推 transcript）没有带过来：那条路的输入是 kimi 自己的消息
形状，本仓的历史由服务端从 pydantic-ai 的消息推出来。`__tests__/layers.test.ts` 里对应的那些用例
一并去掉。
