# vendor：kimi code 的 transcript 数据层

照抄来的外部合同，出处：

- 包：`@moonshot-ai/transcript` 0.0.2（MIT，见 `LICENSE`）
- 仓库：https://github.com/MoonshotAI/kimi-code，目录 `packages/transcript`

**这个目录不改，要改改外面。** 它是我们与协议之间那份逐字一致的凭据：服务端发的每一帧都按
`contract/schema.ts` 里的 zod 校验，改一个字母就整帧被拒。适配、封装、状态管理一律放在
`../` 下面。

上游的两份测试也一并带来（`__tests__/`），它们是「没改坏」的免费证明。

## 唯一做过的改写

上游用 `#/x` 这种包内路径引用自己（靠 package.json 的 `imports` 字段解析），vendor 之后没有
那个字段，所以测试里的 `from '#/x'` 机械改成了相对路径。`src` 那些文件本来就用相对路径，一个
字没动。
