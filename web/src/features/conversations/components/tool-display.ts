/**
 * 工具卡画成什么，由服务端在 `display` 里说，这里只把它翻成图标与文案。
 *
 * **不看工具名**：卡片认的是 `display.kind`（协议定死的一个封闭联合），后端加一件工具，这里不用
 * 跟着改；认不出的画一张朴素的卡。工具名本身不上界面。
 */

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

/** 副标题的长度上限：再长就把状态点挤出行外。 */
const DETAIL_MAX = 60

const clip = (text: string): string =>
  text.length > DETAIL_MAX ? `${text.slice(0, DETAIL_MAX)}…` : text

/** 地址只留域名与路径：查询串对人没有信息，却能把一行占满。地址不合法就原样截断。 */
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
  /** 副标题，比如文件路径；没有就不显示。 */
  detail?: string
  /** 文件操作的种类，活动组按它聚合；不是文件操作就没有。 */
  operation?: keyof typeof fileOperationLabels
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
      // 只露读的是哪一份文档；skill 名是内部资产的名字，不上界面。
      return card.args === undefined
        ? { icon: 'reference', label: '读规范' }
        : { detail: card.args, icon: 'reference', label: '读规范' }
    case 'agent_call':
      return { detail: clip(card.prompt), icon: 'agent', label: '派活' }
    case 'generic':
      return { icon: 'task', label: card.summary }
  }
}

const mediaGridSchema = z.object({
  items: z.array(z.object({ caption: z.string(), url: z.string() })),
})

/** 媒体墙上的一张：地址加一句标题。 */
export type MediaGridItem = z.output<typeof mediaGridSchema>['items'][number]

/**
 * 这次调用要在工具行下面画哪几张图。
 *
 * 三件事都成立才画：服务端点了媒体墙这个渲染器、调用跑完了、`metadata` 解析得出条目。形状
 * 对不上就当一张都没有——这份东西由工具自己造，画不出来时退回朴素的工具行，不让整块崩掉。
 * 分组那一侧按同一个判据把它排除在活动组之外，两处不能各判一次。
 *
 * @param frame - 这次调用。
 * @returns 这一排图；不该画就是空的。
 */
export const toolMedia = (frame: ToolCallFrame): readonly MediaGridItem[] => {
  if (frame.view !== 'media_grid' || frame.state !== 'done') return []
  const parsed = mediaGridSchema.safeParse(frame.metadata)
  return parsed.success ? parsed.data.items : []
}
