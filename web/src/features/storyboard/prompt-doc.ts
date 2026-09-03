/**
 * 一组 prompt 的可编辑模型：按行拆，行内把 `@ImageN` 拆成帧记号，其余一字不动。
 *
 * 这份模型的全部意义是**往返保真**：`serialize(parse(text)) === text` 对任何文本成立，唯一允许
 * 的变化是帧增删移位之后的编号重排。所以这里不 trim、不合并空行、不改标点，时间线的头
 * `[起–止秒｜镜头N]` 也原样留着——编辑器只在这份模型上动手，prompt 是调过的资产。
 */

import { isSceneHeader, type Shot } from './shots'

/** 只认 `@Image` 后面不带前导零的编号；`@Image01` 这种当普通文字，原样往返。 */
const FRAME_REF = /@Image([1-9]\d*)/g

export type PromptInline = { kind: 'text'; text: string } | { kind: 'frame'; n: number }

/** 一行正文：文字与帧记号交替；空行就是空数组。 */
export type PromptLine = PromptInline[]

/**
 * 一个段落：一行时间线头（前言没有头，`header` 为 null）加它下面的正文行。
 */
export interface PromptSection {
  header: string | null
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

/**
 * 把 prompt 原文拆成段落与行。
 *
 * @param prompt - 一组的 prompt。
 * @returns 文档模型；第一段是前言（可能一行都没有）。
 */
export const parsePromptDoc = (prompt: string): PromptDoc => {
  const sections: PromptSection[] = [{ header: null, lines: [] }]
  for (const line of prompt.split('\n')) {
    if (isSceneHeader(line)) {
      sections.push({ header: line, lines: [] })
      continue
    }
    sections.at(-1)?.lines.push(parseLine(line))
  }
  return { sections }
}

const serializeLine = (line: PromptLine): string =>
  line.map((inline) => (inline.kind === 'text' ? inline.text : `@Image${inline.n}`)).join('')

/** 几行拼成文本，行间 `\n`。编辑器比对「文档变没变」用它。 */
export const serializeLines = (lines: readonly PromptLine[]): string =>
  lines.map(serializeLine).join('\n')

/**
 * 把文档模型拼回 prompt 原文。
 *
 * @param doc - 文档模型。
 * @returns 与解析前逐字相同的文本（只要中间没改过）。
 */
export const serializePromptDoc = (doc: PromptDoc): string => {
  const lines: string[] = []
  for (const section of doc.sections) {
    if (section.header !== null) lines.push(section.header)
    for (const line of section.lines) lines.push(serializeLine(line))
  }
  return lines.join('\n')
}

/** 文档里按出现次序列出的帧编号（不去重）。 */
export const frameMentions = (doc: PromptDoc): number[] =>
  doc.sections.flatMap((section) =>
    section.lines.flatMap((line) =>
      line.flatMap((inline) => (inline.kind === 'frame' ? [inline.n] : [])),
    ),
  )

/**
 * 按映射重排帧编号；映射给 null 的帧记号整颗抠掉，连同它前面紧贴的一个空格。
 *
 * @param doc - 文档模型。
 * @param remap - 旧编号 → 新编号；null 表示这一帧没了。
 * @returns 新文档；原对象不动。
 */
export const renumberFrames = (doc: PromptDoc, remap: (n: number) => number | null): PromptDoc => ({
  sections: doc.sections.map((section) => ({
    header: section.header,
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

/** 相邻的文字段并成一段，抠掉帧记号之后才会出现这种情况。 */
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

/** 面板上对一组帧能做的事。编号都是 `@ImageN` 的 N。 */
export type FrameOp =
  | { type: 'replace'; n: number; url: string }
  | { type: 'remove'; n: number }
  | { type: 'move'; n: number; to: number }
  | {
      /** 在第 `after` 帧之后插一张（0 = 插到最前），记号追加到 `sectionIndex` 那一段最后一个非空行末尾。 */
      type: 'insert'
      after: number
      url: string
      sectionIndex: number
    }

/**
 * 对一组执行一次帧操作：`imageUrls` 与 prompt 里的编号在同一步里一起变，中间不存在编号越界的状态。
 *
 * @param shot - 这一组。
 * @param op - 要做的事。
 * @returns 改好的组；原对象不动。
 */
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
      // 夹在起点与终点之间的那些帧整体挪一位，起点落到终点
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

/**
 * 按后端那套规矩预检一组：编号不越界、秒数在范围里。过不了的写回一定会 422，不如先在本地拦住。
 *
 * @param shot - 这一组。
 * @returns 出错原因；没问题就是 undefined。
 */
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
