/** app 层连接 shared 宿主与 feature 渲染器，避免 shared 反向依赖 feature。 */

import { SubAgentPanel, agentCallOf } from '@/features/conversations'
import { SHOTS_PATH, StoryboardPanel } from '@/features/storyboard'
import { WorkspaceFilesPanel } from '@/features/workspace'
import { ArtifactRegistry } from '@/shared/workbench'

export const workbenchRegistry = new ArtifactRegistry()

// 分镜是唯一自动展开面板的产物：agent 交付 video_shot.json 那一刻面板打开。
workbenchRegistry.register({
  autoOpen: true,
  component: StoryboardPanel,
  empty: 'agent 交付分镜后出现',
  icon: 'grid',
  label: '分镜',
  match: { path: SHOTS_PATH },
  title: () => '分镜',
  type: 'storyboard',
})

// 工作区里有文件就能翻，但不自动展开，用户从面板菜单里点进来。
workbenchRegistry.register({
  autoOpen: false,
  component: WorkspaceFilesPanel,
  empty: '还没有文件',
  icon: 'folder',
  label: '文件',
  match: { workspace: true },
  title: () => '文件',
  type: 'workspace',
})

/** 菜单行尾放得下的任务摘要长度。 */
const DETAIL_MAX = 14

const clip = (text: string): string =>
  text.length > DETAIL_MAX ? `${text.slice(0, DETAIL_MAX)}…` : text

// 派活卡不自动打开，点卡上的「查看」才切过来；打开的那一件才占标签位。
workbenchRegistry.register({
  autoOpen: false,
  component: SubAgentPanel,
  // 同一个子代理派过几次，菜单里靠任务摘要分开。
  detail: (source) => {
    const prompt = source.kind === 'frame' ? agentCallOf(source.display)?.prompt : undefined
    return prompt === undefined ? undefined : clip(prompt)
  },
  icon: 'agent',
  label: '委派任务',
  match: { displayKind: 'agent_call' },
  title: (source) =>
    `委派任务 · ${(source.kind === 'frame' ? agentCallOf(source.display)?.agentName : undefined) ?? '子代理'}`,
  type: 'sub-agent',
})
