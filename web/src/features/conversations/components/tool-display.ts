/** 根据服务端 display.kind 映射图标与文案；工具名属于内部标识，不展示给用户。 */

import { z } from 'zod'
import type { ToolCallFrame } from '@/shared/transcript/vendor'
import type { IconName } from '@/shared/icons'

const fileOperationLabels = {
  edit: '改文件',
  glob: '列目录',
  grep: '搜内容',
  read: '读文件',
  write: '写文件',
} as const

const fileOperationIcons: Record<keyof typeof fileOperationLabels, IconName> = {
  edit: 'edit',
  glob: 'folder',
  grep: 'search',
  read: 'file',
  write: 'file',
}

const displaySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('file_io'),
    operation: z.enum(['read', 'write', 'edit', 'glob', 'grep']),
    path: z.string(),
  }),
  z.object({ kind: z.literal('search'), query: z.string() }),
  z.object({ kind: z.literal('url_fetch'), url: z.string() }),
  z.object({
    kind: z.literal('skill_call'),
    skill_name: z.string(),
    args: z.string().optional(),
  }),
  z.object({ kind: z.literal('agent_call'), agent_name: z.string(), prompt: z.string() }),
  z.object({ kind: z.literal('generic'), summary: z.string() }),
])

/** 限制副标题长度，避免挤出状态标记。 */
const DETAIL_MAX = 60

const clip = (text: string): string =>
  text.length > DETAIL_MAX ? `${text.slice(0, DETAIL_MAX)}…` : text

/** 仅显示域名与路径；无法解析时按原文截断。 */
const shortUrl = (url: string): string => {
  try {
    const parsed = new URL(url)
    return clip(`${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`)
  } catch {
    return clip(url)
  }
}

export type ToolCard = {
  icon: IconName
  label: string
  detail?: string
  /** 活动组按文件操作类型聚合。 */
  operation?: keyof typeof fileOperationLabels
}

export const toolCard = (display: unknown): ToolCard => {
  const parsed = displaySchema.safeParse(display)
  if (!parsed.success) return { icon: 'task', label: '工具调用' }
  const card = parsed.data
  switch (card.kind) {
    case 'file_io':
      return {
        detail: card.path,
        icon: fileOperationIcons[card.operation],
        label: fileOperationLabels[card.operation],
        operation: card.operation,
      }
    case 'search':
      return { detail: clip(card.query), icon: 'search', label: '搜内容' }
    case 'url_fetch':
      return { detail: shortUrl(card.url), icon: 'external', label: '取网页' }
    case 'skill_call':
      // 仅展示文档路径，内部 skill 名不进入界面。
      return card.args === undefined
        ? { icon: 'reference', label: '读规范' }
        : { detail: card.args, icon: 'reference', label: '读规范' }
    case 'agent_call':
      return { detail: clip(card.prompt), icon: 'agent', label: '派活' }
    case 'generic':
      return { icon: 'task', label: card.summary }
  }
}

/** 派活卡上的子代理名与任务文本；不是派活卡就没有。 */
export const agentCallOf = (
  display: unknown,
): { agentName: string; prompt: string } | undefined => {
  const parsed = displaySchema.safeParse(display)
  if (!parsed.success || parsed.data.kind !== 'agent_call') return undefined
  return { agentName: parsed.data.agent_name, prompt: parsed.data.prompt }
}

const mediaGridSchema = z.object({
  items: z.array(z.object({ caption: z.string(), url: z.string() })),
})

export type MediaGridItem = z.output<typeof mediaGridSchema>['items'][number]

/** 仅展示已完成且 metadata 合法的媒体墙；活动分组复用此判据，保证媒体始终可见。 */
export const toolMedia = (frame: ToolCallFrame): readonly MediaGridItem[] => {
  if (frame.view !== 'media_grid' || frame.state !== 'done') return []
  const parsed = mediaGridSchema.safeParse(frame.metadata)
  return parsed.success ? parsed.data.items : []
}
