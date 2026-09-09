/**
 * 工具卡的数据全部来自服务端的 display / view / metadata（ADR-0007）：display 画卡头，
 * view 选卡身，metadata 填角标与卡身。工具名属于内部标识，不展示给用户。
 * 标题词表与写法见 docs/tool-design.md §4。
 */

import { z } from 'zod'
import type { ToolCallFrame } from '@/shared/transcript/vendor'
import type { IconName } from '@/shared/icons'

const fileOperationLabels = {
  edit: '编辑文件',
  glob: '浏览目录',
  grep: '搜索内容',
  read: '读取文件',
  write: '写入文件',
} as const

type FileOperation = keyof typeof fileOperationLabels

const fileOperationIcons: Record<FileOperation, IconName> = {
  edit: 'edit',
  glob: 'folder',
  grep: 'search',
  read: 'file',
  write: 'file',
}

/** 服务端按 pydantic 序列化，可选字段可能是 null 也可能缺席，两种都当没有。 */
const optionalText = z.string().nullish()

const displaySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('file_io'),
    operation: z.enum(['read', 'write', 'edit', 'glob', 'grep']),
    path: z.string(),
    content: optionalText,
    before: optionalText,
    after: optionalText,
  }),
  z.object({ kind: z.literal('search'), query: z.string(), scope: optionalText }),
  z.object({ kind: z.literal('url_fetch'), url: z.string() }),
  z.object({ kind: z.literal('skill_call'), skill_name: z.string(), args: optionalText }),
  z.object({ kind: z.literal('agent_call'), agent_name: z.string(), prompt: z.string() }),
  z.object({ kind: z.literal('generic'), summary: z.string(), detail: optionalText }),
])

/** 主语最长 60 字，再长就挤掉角标和状态。 */
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
  /** 标题：书面动宾短语。 */
  label: string
  /** 主语：这一步作用的对象实例。 */
  detail?: string
  /** 主语是路径或地址时用等宽字。 */
  mono?: boolean
  /** 活动组按操作类型聚合；检索按 grep 归类。 */
  operation?: FileOperation
}

const FALLBACK_CARD: ToolCard = { icon: 'task', label: '调用工具' }

/** 卡头。媒体类结果的兜底卡用图片图标，其余兜底卡用清单图标。 */
export const toolCard = (display: unknown, view?: string): ToolCard => {
  const parsed = displaySchema.safeParse(display)
  if (!parsed.success) return FALLBACK_CARD
  const card = parsed.data
  switch (card.kind) {
    case 'file_io':
      return {
        detail: card.path,
        icon: fileOperationIcons[card.operation],
        label: fileOperationLabels[card.operation],
        mono: true,
        operation: card.operation,
      }
    case 'search':
      return { detail: clip(card.query), icon: 'search', label: '搜索工作区', operation: 'grep' }
    case 'url_fetch':
      return { detail: shortUrl(card.url), icon: 'external', label: '读取网页', mono: true }
    case 'skill_call':
      // 只展示文档名，skill 名不进入界面。
      return card.args
        ? { detail: card.args, icon: 'reference', label: '查阅规范' }
        : { icon: 'reference', label: '查阅规范' }
    case 'agent_call':
      return { detail: clip(card.prompt), icon: 'agent', label: '委派任务' }
    case 'generic': {
      const icon: IconName = view === 'media_grid' ? 'image' : 'task'
      return card.detail
        ? { detail: card.detail, icon, label: card.summary }
        : { icon, label: card.summary }
    }
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

export type FileChange = { before: string; after: string } | { content: string }

/** 审批卡预览用：编辑给前后文，写入给整份内容；别的 display 没有可预览的东西。 */
export const fileChangeOf = (display: unknown): FileChange | undefined => {
  const parsed = displaySchema.safeParse(display)
  if (!parsed.success || parsed.data.kind !== 'file_io') return undefined
  const { before, after, content } = parsed.data
  if (typeof before === 'string' && typeof after === 'string') return { after, before }
  if (typeof content === 'string') return { content }
  return undefined
}

// --- 结果：metadata 的形状由 view 决定 ---------------------------------------

const fileContentMeta = z.object({
  path: z.string(),
  lines: z.number().int().nonnegative(),
  truncated: z.boolean(),
})

const searchResultsMeta = z.object({
  query: z.string(),
  matches: z.array(z.object({ file: z.string(), line: z.number().int(), text: z.string() })),
  truncated: z.boolean(),
})

const mediaGridMeta = z.object({
  items: z.array(z.object({ caption: z.string(), url: z.string() })),
  note: optionalText,
})

/** 没有卡身渲染器的工具只能带角标，或者声明正文不给展开。 */
const noteMeta = z.object({
  chip: optionalText,
  added: z.number().int().nullish(),
  removed: z.number().int().nullish(),
  body: z.literal('none').nullish(),
})

export type SearchMatch = z.output<typeof searchResultsMeta>['matches'][number]
export type MediaGridItem = z.output<typeof mediaGridMeta>['items'][number]

export type ToolResult =
  | { kind: 'file_content'; path: string; lines: number; truncated: boolean }
  | { kind: 'search_results'; query: string; matches: readonly SearchMatch[]; truncated: boolean }
  | { kind: 'media_grid'; items: readonly MediaGridItem[]; note?: string }
  | { kind: 'note'; chip?: string; added?: number; removed?: number; hideBody: boolean }

/** 按 view 解析 metadata；形状对不上就当没有结果，卡退回朴素行。 */
export const toolResult = (frame: ToolCallFrame): ToolResult | undefined => {
  switch (frame.view) {
    case 'file_content': {
      const parsed = fileContentMeta.safeParse(frame.metadata)
      return parsed.success ? { kind: 'file_content', ...parsed.data } : undefined
    }
    case 'search_results': {
      const parsed = searchResultsMeta.safeParse(frame.metadata)
      return parsed.success ? { kind: 'search_results', ...parsed.data } : undefined
    }
    case 'media_grid': {
      const parsed = mediaGridMeta.safeParse(frame.metadata)
      if (!parsed.success) return undefined
      const { items, note } = parsed.data
      return note ? { items, kind: 'media_grid', note } : { items, kind: 'media_grid' }
    }
    case undefined: {
      const parsed = noteMeta.safeParse(frame.metadata ?? {})
      if (!parsed.success) return undefined
      const { chip, added, removed, body } = parsed.data
      return {
        kind: 'note',
        hideBody: body === 'none',
        ...(chip ? { chip } : {}),
        ...(typeof added === 'number' ? { added } : {}),
        ...(typeof removed === 'number' ? { removed } : {}),
      }
    }
    default:
      return undefined
  }
}

/** 卡尾的文字角标；改文件的增删数另走 toolDiff。 */
export const toolChip = (frame: ToolCallFrame): string | undefined => {
  const result = toolResult(frame)
  if (result === undefined) return undefined
  switch (result.kind) {
    case 'file_content':
      return result.truncated ? `${result.lines} 行 · 未读完` : `${result.lines} 行`
    case 'search_results':
      return result.matches.length === 0 ? '无命中' : `${result.matches.length} 处命中`
    case 'media_grid':
      return result.note ?? `${result.items.length} 张`
    case 'note':
      return result.chip
  }
}

/** 改文件的增删行数；没改动或不是改文件就没有。 */
export const toolDiff = (frame: ToolCallFrame): { added: number; removed: number } | undefined => {
  const result = toolResult(frame)
  if (result?.kind !== 'note') return undefined
  const added = result.added ?? 0
  const removed = result.removed ?? 0
  return added + removed > 0 ? { added, removed } : undefined
}

/** 仅展示已完成且形状合法的媒体墙；活动分组复用此判据，保证媒体始终可见。 */
export const toolMedia = (frame: ToolCallFrame): readonly MediaGridItem[] => {
  if (frame.state !== 'done') return []
  const result = toolResult(frame)
  return result?.kind === 'media_grid' ? result.items : []
}

/** 能展开看的原始结果：多行字符串，且工具没声明不给看。一句话的结果卡头已经说完。 */
export const toolBodyText = (frame: ToolCallFrame): string | undefined => {
  if (typeof frame.output !== 'string' || !frame.output.includes('\n')) return undefined
  const result = toolResult(frame)
  return result?.kind === 'note' && result.hideBody ? undefined : frame.output
}
