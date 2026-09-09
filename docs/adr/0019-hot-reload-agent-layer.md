# ADR-0019：模型表与 agent 层运行期热重载

- 状态：已接受（2026-09-09）
- 关联：[ADR-0001](0001-architecture-foundations.md)（§2「启动期装配并冻结」由本文放宽为「启动期装配，运行期可整体替换」）

## 背景

模型、agent、skill 与其参考资料原先随镜像发版：加一个模型或改一段 prompt 都要走 develop → main → 标签 → 出镜像 → 换 `IMAGE_TAG`。配置目录改为挂载进容器后（README「配置发布」），文件能独立于镜像更新，但进程装配在 import 期完成，改完仍要重启后端，正在跑的运行会被打断。

## 决策

### 1. 热层边界

`config.yaml` 的 `models` 段、`conversations.title_model` 与 `agents/` 目录下的一切（`agents.yaml`、`agent.yaml`、`instructions.md`、`SKILL.md`、references）构成一层，由 [app/agent_layer.py](../../server/src/iclip/app/agent_layer.py) 一次装配成不可变对象：模型实例表、agent 注册表、上下文窗口表、标题生成函数。运行驱动、transcript 服务与对话模块拿到的是「读当前层」的视图，不直接持有注册表。

其余配置段（`db`、`security`、`sso`、`media_generation`、`shot_video`、`agent_runs`、`ops`）与全部环境变量在启动期冻结。它们决定连接池、队列、路由与中间件，替换等于重建进程。

### 2. 触发与结果

进程收到 `SIGHUP` 时从同样两个路径重读配置与声明，完整装配新的一层，全部成功后才替换；替换是同步操作，对 asyncio 里正在跑的协程原子。已开始的运行在起步时同时取到 agent 与它的上下文窗口，跑完为止用的都是旧层。

结果写在 `GET /healthz` 的 `config` 段：`generation` 每次成功递增，`error` 是失败原因，`needs_restart` 为真表示改动落在非热区段。`status` 恒为 `ok`，探活与 compose 的健康检查不受重载结果影响。发布脚本只凭这一段判断成功、失败还是改走重启，不需要任何凭证。

### 3. 拒绝规则

重载前用新配置算一遍 `resolve_settings`，逐字段比对非热字段；任一不同即拒绝并标 `needs_restart`，不做部分生效。装配途中任何异常（声明引用了不存在的模型、skill 目录缺失、模型的 `api_key_env` 在容器里没有值）同样拒绝，旧层原样保留，原因进日志与 `/healthz`。

### 4. 模型实例

声明未变的模型沿用上一层的实例：只改 agent 或 skill 时不重建任何模型客户端。被换下的客户端不主动关闭，在途运行可能仍在用，交给垃圾回收；重载是低频操作，这点开销可接受。

## 后果

- 加模型、加 agent、改 prompt 与 skill 都不再需要发版或重启；只改非热区段或环境变量时脚本自动改走重启。
- 单进程内存里多了一份可替换的状态，但它只影响新运行的起步，不进入跨 worker 正确性（ADR-0001 §3 不变）。
- 客户端引用的 agent id 仍以当前层为准：重载后被删掉的 agent，新提交会得到「未注册的 agent」。
