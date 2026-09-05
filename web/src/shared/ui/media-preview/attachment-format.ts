/** 参考 Kimi mention 提示：KB 取整、MB 一位小数；文件名按 grapheme 截断至 32，优先保留扩展名及其前四字。 */

const KB = 1024
const MB = 1024 * 1024

export const formatAttachmentSize = (bytes: number): string => {
  if (bytes < KB) return `${bytes} B`
  if (bytes < MB) return `${Math.round(bytes / KB)} KB`
  return `${(bytes / MB).toFixed(1)} MB`
}

const NAME_MAX_GRAPHEMES = 32
/** 扩展名前额外保留的字符数。 */
const TAIL_EXTRA = 4

let segmenter: Intl.Segmenter | undefined
/** 按 grapheme 分段，避免拆开 emoji 和组合字符。 */
const graphemes = (text: string): string[] => {
  segmenter ??= new Intl.Segmenter('und', { granularity: 'grapheme' })
  return [...segmenter.segment(text)].map((part) => part.segment)
}

const headEllipsize = (name: string, limit: number): string => {
  const chars = graphemes(name)
  return chars.length <= limit ? name : `${chars.slice(0, limit - 1).join('')}…`
}

export const ellipsizeAttachmentName = (name: string): string => {
  const chars = graphemes(name)
  if (chars.length <= NAME_MAX_GRAPHEMES) return name
  const dot = name.lastIndexOf('.')
  const tailLength = (dot > 0 ? graphemes(name.slice(dot)).length : 0) + TAIL_EXTRA
  const headLength = NAME_MAX_GRAPHEMES - 1 - tailLength
  if (headLength < 2) return headEllipsize(name, NAME_MAX_GRAPHEMES)
  return `${chars.slice(0, headLength).join('')}…${chars.slice(chars.length - tailLength).join('')}`
}
