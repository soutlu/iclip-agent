/** app 层连接 shared 宿主与 feature 渲染器，避免 shared 反向依赖 feature。 */

import { SubAgentPanel, agentCallOf } from '@/features/conversations'
import { SHOTS_PATH, StoryboardPanel } from '@/features/storyboard'
import { ArtifactRegistry } from '@/shared/workbench'

export const workbenchRegistry = new ArtifactRegistry()

workbenchRegistry.register({
  autoOpen: true,
  component: StoryboardPanel,
  match: { path: SHOTS_PATH },
  title: () => '分镜',
  type: 'storyboard',
})

// 派活卡不自动打开，点卡上的「查看」才切过来；同一宿主里与分镜二选一，照 kimi 同时只开一个。
workbenchRegistry.register({
  autoOpen: false,
  component: SubAgentPanel,
  match: { displayKind: 'agent_call' },
  title: (source) =>
    `派活 · ${(source.kind === 'frame' ? agentCallOf(source.display)?.agentName : undefined) ?? '子代理'}`,
  type: 'sub-agent',
})
