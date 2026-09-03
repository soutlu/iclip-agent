/**
 * 附件展示的格式化：大小与文件名截断都照 kimi 网页版 composer 的口径。
 *
 * 大小是 mention 悬停提示那一套（`<1KB` 原样 `N B`、KB 四舍五入取整、MB 一位小数）——
 * 它与媒体卡那套（KB 也带一位小数）是两回事，不能合并。
 * 文件名截断超 32 个 grapheme 时保留扩展名做中间省略（`头…尾`），尾巴是扩展名再往前多留
 * 4 个字符；留不出头（不足 2 个字符）就退化成纯头部省略。
 */

const KB = 1024
const MB = 1024 * 1024

/**
 * 把字节数格式化成 kimi 悬停提示里的样子。
 *
 * @param bytes - 字节数。
 * @returns 形如 `512 B`、`42 KB`、`1.0 MB` 的文案。
 */
export const formatAttachmentSize = (bytes: number): string => {
  if (bytes < KB) return `${bytes} B`
  if (bytes < MB) return `${Math.round(bytes / KB)} KB`
  return `${(bytes / MB).toFixed(1)} MB`
}

const NAME_MAX_GRAPHEMES = 32
/** 尾巴在扩展名之外再多留的字符数（照 kimi）。 */
const TAIL_EXTRA = 4

let segmenter: Intl.Segmenter | undefined
/** 按 grapheme 切段：emoji 与组合字符不劈开（`und`  locale 照 kimi）。 */
const graphemes = (text: string): string[] => {
  segmenter ??= new Intl.Segmenter('und', { granularity: 'grapheme' })
  return [...segmenter.segment(text)].map((part) => part.segment)
}

/** 头部省略：留下前 limit-1 个字符加省略号。 */
const headEllipsize = (name: string, limit: number): string => {
  const chars = graphemes(name)
  return chars.length <= limit ? name : `${chars.slice(0, limit - 1).join('')}…`
}

/**
 * 截断附件名给 pill 显示。
 *
 * @param name - 原始文件名。
 * @returns 不超过 32 个 grapheme 的显示名。
 */
export const ellipsizeAttachmentName = (name: string): string => {
  const chars = graphemes(name)
  if (chars.length <= NAME_MAX_GRAPHEMES) return name
  const dot = name.lastIndexOf('.')
  const tailLength = (dot > 0 ? graphemes(name.slice(dot)).length : 0) + TAIL_EXTRA
  const headLength = NAME_MAX_GRAPHEMES - 1 - tailLength
  if (headLength < 2) return headEllipsize(name, NAME_MAX_GRAPHEMES)
  return `${chars.slice(0, headLength).join('')}…${chars.slice(chars.length - tailLength).join('')}`
}
