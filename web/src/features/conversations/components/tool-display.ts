/**
 * 工具卡画成什么，由服务端在 `display` 里说，这里只把它翻成图标与文案。
 *
 * **不看工具名**：卡片认的是 `display.kind`（协议定死的一个封闭联合），后端加一件工具，这里不用
 * 跟着改；认不出的画一张朴素的卡。工具名本身不上界面。
 */

import { z } from 'zod'
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
  z.object({ kind: z.literal('generic'), summary: z.string() }),
])

export type ToolCard = {
  icon: IconName
  label: string
  /** 副标题，比如文件路径；没有就不显示。 */
  detail?: string
}

/**
 * 把一次工具调用的 `display` 翻成卡片上的图标与文字。
 *
 * @param display - 服务端给的卡片形状。
 * @returns 卡片文案。
 */
export const toolCard = (display: unknown): ToolCard => {
  const parsed = displaySchema.safeParse(display)
  if (!parsed.success) return { icon: 'task', label: '工具调用' }
  if (parsed.data.kind === 'generic') return { icon: 'task', label: parsed.data.summary }
  return {
    detail: parsed.data.path,
    icon: fileOperationIcons[parsed.data.operation],
    label: fileOperationLabels[parsed.data.operation],
  }
}

/**
 * 文件操作的工具调用给出它的操作种类（活动组聚合用）；不是文件操作就给 undefined。
 *
 * @param display - 服务端给的卡片形状。
 * @returns 操作种类。
 */
export const toolOperation = (display: unknown): keyof typeof fileOperationLabels | undefined => {
  const parsed = displaySchema.safeParse(display)
  return parsed.success && parsed.data.kind === 'file_io' ? parsed.data.operation : undefined
}
