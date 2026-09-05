/** 保证 serialize(parse(text)) === text：保留空白、空行、标点与时间线头，仅帧操作可重排编号。 */

import { parseSceneHeader, type Shot } from './shots'

/** 只识别无前导零的正整数帧编号；@Image01 保持普通文本。 */
const FRAME_REF = /@Image([1-9]\d*)/g

export type PromptInline = { kind: 'text'; text: string } | { kind: 'frame'; n: number }

/** 每行由文字与帧记号组成，空行为空数组。 */
export type PromptLine = PromptInline[]

/** 前言的 header 为 null，其余段落包含时间线头和正文。 */
export interface PromptSection {
  header: string | null
  /** 首行正文是否紧接时间线头，序列化时保留原始换行位置。 */
  inlineBody: boolean
  lines: PromptLine[]
}

export interface PromptDoc {
  sections: PromptSection[]
}

const parseLine = (line: string): PromptLine => {
  const inlines: PromptLine = []
  let cursor = 0
  for (const match of line.matchAll(FRAME_REF)) {
    if (match.index > cursor) inlines.push({ kind: 'text', text: line.slice(cursor, match.index) })
    inlines.push({ kind: 'frame', n: Number(match[1]) })
    cursor = match.index + match[0].length
  }
  if (cursor < line.length) inlines.push({ kind: 'text', text: line.slice(cursor) })
  return inlines
}

/** 首段始终是前言，允许为空。 */
export const parsePromptDoc = (prompt: string): PromptDoc => {
  const sections: PromptSection[] = [{ header: null, inlineBody: false, lines: [] }]
  for (const line of prompt.split('\n')) {
    const header = parseSceneHeader(line)
    if (header !== undefined) {
      sections.push({
        header: header.text,
        inlineBody: header.body.length > 0,
        lines: header.body.length === 0 ? [] : [parseLine(header.body)],
      })
      continue
    }
    sections.at(-1)?.lines.push(parseLine(line))
  }
  return { sections }
}

const serializeLine = (line: PromptLine): string =>
  line.map((inline) => (inline.kind === 'text' ? inline.text : `@Image${inline.n}`)).join('')

export const serializeLines = (lines: readonly PromptLine[]): string =>
  lines.map(serializeLine).join('\n')

export const serializePromptDoc = (doc: PromptDoc): string => {
  const lines: string[] = []
  for (const section of doc.sections) {
    if (section.header !== null) {
      lines.push(section.header + (section.inlineBody ? serializeLine(section.lines[0] ?? []) : ''))
    }
    for (const line of section.inlineBody ? section.lines.slice(1) : section.lines) {
      lines.push(serializeLine(line))
    }
  }
  return lines.join('\n')
}

/** 按出现顺序返回帧编号，保留重复引用。 */
export const frameMentions = (doc: PromptDoc): number[] =>
  doc.sections.flatMap((section) =>
    section.lines.flatMap((line) =>
      line.flatMap((inline) => (inline.kind === 'frame' ? [inline.n] : [])),
    ),
  )

/** 重排编号；映射为 null 时删除记号及其前方紧邻的一个空格，返回新文档。 */
export const renumberFrames = (doc: PromptDoc, remap: (n: number) => number | null): PromptDoc => ({
  sections: doc.sections.map((section) => ({
    ...section,
    lines: section.lines.map((line) => {
      const next: PromptLine = []
      for (const inline of line) {
        if (inline.kind === 'text') {
          next.push(inline)
          continue
        }
        const mapped = remap(inline.n)
        if (mapped !== null) {
          next.push({ kind: 'frame', n: mapped })
          continue
        }
        const previous = next.at(-1)
        if (previous?.kind === 'text' && previous.text.endsWith(' ')) {
          next[next.length - 1] = { kind: 'text', text: previous.text.slice(0, -1) }
        }
      }
      return mergeText(next)
    }),
  })),
})

const mergeText = (line: PromptLine): PromptLine =>
  line.reduce<PromptLine>((merged, inline) => {
    const previous = merged.at(-1)
    if (inline.kind === 'text' && previous?.kind === 'text') {
      merged[merged.length - 1] = { kind: 'text', text: previous.text + inline.text }
    } else if (inline.kind !== 'text' || inline.text.length > 0) {
      merged.push(inline)
    }
    return merged
  }, [])

/** 帧编号使用 @ImageN 的 N，从 1 开始。 */
export type FrameOp =
  | { type: 'replace'; n: number; url: string }
  | { type: 'remove'; n: number }
  | { type: 'move'; n: number; to: number }
  | {
      /** after 为 0 时插入最前；记号追加到指定段落最后一个非空行末尾。 */
      type: 'insert'
      after: number
      url: string
      sectionIndex: number
    }

/** 同步修改 imageUrls 与 prompt 引用编号，避免中间状态引用越界。 */
export const applyFrameOp = (shot: Shot, op: FrameOp): Shot => {
  const urls = [...shot.imageUrls]
  const doc = parsePromptDoc(shot.prompt)
  switch (op.type) {
    case 'replace': {
      if (op.n < 1 || op.n > urls.length) return shot
      urls[op.n - 1] = op.url
      return { ...shot, imageUrls: urls }
    }
    case 'remove': {
      if (op.n < 1 || op.n > urls.length) return shot
      urls.splice(op.n - 1, 1)
      const renumbered = renumberFrames(doc, (n) => (n === op.n ? null : n > op.n ? n - 1 : n))
      return { ...shot, imageUrls: urls, prompt: serializePromptDoc(renumbered) }
    }
    case 'move': {
      const { n, to } = op
      if (n < 1 || n > urls.length || to < 1 || to > urls.length || n === to) return shot
      const moved = urls[n - 1]
      if (moved === undefined) return shot
      urls.splice(n - 1, 1)
      urls.splice(to - 1, 0, moved)
      const remap = (m: number): number => {
        if (m === n) return to
        if (n < to && m > n && m <= to) return m - 1
        if (n > to && m >= to && m < n) return m + 1
        return m
      }
      return { ...shot, imageUrls: urls, prompt: serializePromptDoc(renumberFrames(doc, remap)) }
    }
    case 'insert': {
      const after = Math.min(Math.max(op.after, 0), urls.length)
      urls.splice(after, 0, op.url)
      const shifted = renumberFrames(doc, (n) => (n > after ? n + 1 : n))
      const section = shifted.sections[op.sectionIndex] ?? shifted.sections.at(-1)
      if (section !== undefined) {
        const target = section.lines.findLastIndex((line) => line.length > 0)
        const line = target === -1 ? [] : (section.lines[target] ?? [])
        const withFrame: PromptLine = [
          ...line,
          { kind: 'text', text: ' ' },
          { kind: 'frame', n: after + 1 },
        ]
        if (target === -1) section.lines.push(mergeText(withFrame))
        else section.lines[target] = mergeText(withFrame)
      }
      return { ...shot, imageUrls: urls, prompt: serializePromptDoc(shifted) }
    }
  }
}

/** 秒数的合法范围，与后端校验一致。 */
export const SECONDS_MIN = 4
export const SECONDS_MAX = 30

/** 预检帧编号与秒数范围；失败返回原因，成功返回 undefined。 */
export const validateShot = (shot: Shot): string | undefined => {
  const mentions = frameMentions(parsePromptDoc(shot.prompt))
  const over = mentions.find((n) => n > shot.imageUrls.length)
  if (over !== undefined)
    return `描述里写到了 @Image${over}，但这一组只有 ${shot.imageUrls.length} 张帧`
  if (!Number.isInteger(shot.seconds) || shot.seconds < SECONDS_MIN || shot.seconds > SECONDS_MAX) {
    return `时长要在 ${SECONDS_MIN} 到 ${SECONDS_MAX} 秒之间的整数`
  }
  if (shot.imageUrls.some((url) => url.trim() === '')) return '有一张帧的地址是空的'
  return undefined
}
