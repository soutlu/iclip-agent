import type {
  MarkdownArtifactOutput,
  MarkdownArtifactSourceMedia,
} from '@/features/artifacts/types/markdown.types'
import { isRecord } from '@/shared/lib/guards'

const DEFAULT_MARKDOWN_TITLE = 'Markdown 结果'
const EMPTY_MARKDOWN_BODY = '_暂无 Markdown 正文内容。_'

/**
 * 读取非空字符串。
 *
 * @param value - 待读取的未知值。
 * @returns 去除首尾空白后的字符串；值不是非空字符串时返回 undefined。
 */
const getNonEmptyString = (value: unknown) =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined

/**
 * 从多个候选值中读取第一段非空 Markdown 文本。
 *
 * @param values - 按优先级排列的候选 Markdown 文本。
 * @returns 第一段非空字符串；所有候选都为空时返回 undefined。
 */
const firstNonEmptyString = (...values: unknown[]) => {
  for (const value of values) {
    const normalized = getNonEmptyString(value)

    if (normalized) {
      return normalized
    }
  }

  return undefined
}

/**
 * 归一化 Markdown 来源媒体记录。
 *
 * @param value - 后端或 adapter 提供的来源媒体对象。
 * @returns 可供 Markdown 节点展示和预览的来源媒体；缺少 key、kind 或 url 时返回 undefined。
 */
const normalizeMarkdownSourceMedia = (value: unknown): MarkdownArtifactSourceMedia | undefined => {
  if (!isRecord(value)) {
    return undefined
  }

  const key = getNonEmptyString(value.key)
  const kind = getNonEmptyString(value.kind)
  const url = firstNonEmptyString(
    value.url,
    value.output_url,
    value.outputUrl,
    value.oss_url,
    value.ossUrl,
  )

  if (!key || (kind !== 'image' && kind !== 'video') || !url) {
    return undefined
  }

  const filename = getNonEmptyString(value.filename)
  const ossUrl = firstNonEmptyString(value.oss_url, value.ossUrl)
  const thumbnailUrl = firstNonEmptyString(value.thumbnail_url, value.thumbnailUrl)

  return {
    ...(filename ? { filename } : {}),
    key,
    kind,
    ...(ossUrl ? { ossUrl } : {}),
    ...(thumbnailUrl ? { thumbnailUrl } : {}),
    url,
  }
}

/**
 * 判断 Markdown 行是否是水平分隔线。
 *
 * @param line - 待判断的 Markdown 单行文本。
 * @returns 当该行只包含 3 个及以上横线时返回 true。
 */
const isMarkdownHorizontalRule = (line: string) => /^-{3,}$/.test(line.trim())

/**
 * 规整画布 Markdown 中容易被误解析的水平分隔线。
 *
 * @param markdown - 后端返回的原始 Markdown 正文。
 * @returns 避免正文行被 `---` 误解析为 setext 标题的 Markdown。
 */
const normalizeCanvasMarkdownBody = (markdown: string) => {
  const normalizedLines: string[] = []

  for (const line of markdown.split('\n')) {
    const previousLine = normalizedLines.at(-1)

    if (
      isMarkdownHorizontalRule(line) &&
      previousLine !== undefined &&
      previousLine.trim().length > 0
    ) {
      normalizedLines.push('')
    }

    normalizedLines.push(line)
  }

  return normalizedLines.join('\n')
}

/**
 * 将后端文本 artifact payload 归一化为通用 Markdown 输出。
 *
 * @param value - 后端返回的 Markdown 字符串或 Producer artifact 记录。
 * @returns 可渲染的 Markdown artifact；不符合文本 artifact 结构时返回 null。
 */
export const normalizeMarkdownArtifactOutput = (value: unknown): MarkdownArtifactOutput | null => {
  if (typeof value === 'string') {
    const markdown = getNonEmptyString(value)

    return markdown
      ? {
          markdown: normalizeCanvasMarkdownBody(markdown),
          title: DEFAULT_MARKDOWN_TITLE,
        }
      : null
  }

  if (!isRecord(value)) {
    return null
  }

  const title = firstNonEmptyString(value.title, value.name, value.kind) ?? DEFAULT_MARKDOWN_TITLE
  const markdown =
    firstNonEmptyString(value.markdown, value.content, value.value, value.text, value.body) ??
    EMPTY_MARKDOWN_BODY
  const sourceMedia = normalizeMarkdownSourceMedia(
    value.sourceMedia ?? value.source_media ?? value.media,
  )

  return {
    markdown: normalizeCanvasMarkdownBody(markdown),
    ...(sourceMedia ? { sourceMedia } : {}),
    title,
  }
}
