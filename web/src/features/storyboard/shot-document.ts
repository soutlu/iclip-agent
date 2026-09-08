/** 结构化分镜文件、局部编辑与文本导出；保留字段身份和原始正文。 */

import { z } from 'zod'
import { splitPrompt, type ShotTimeline } from './shots'

const nonblank = z.string().refine((value) => value.trim().length > 0, '内容不能为空')
const timestamp = z.number().nonnegative()
const FRAME_REF = /@Image(\d+)/g

/** 与工具相同，按正文首次出现顺序提取编号；不改写原始标记。 */
export const extractImageIndexes = (prompt: string): number[] => [
  ...new Set([...prompt.matchAll(FRAME_REF)].map((match) => Number(match[1]))),
]

const timelineItemSchema = z.strictObject({
  image_indexes: z.array(z.int().positive()),
  prompt: nonblank,
  timestamps: z.tuple([timestamp, timestamp]),
})

const shotSchema = z
  .strictObject({
    image_urls: z.array(nonblank),
    index: z.int().positive(),
    prompt: z.strictObject({
      global_settings: nonblank,
      timeline: z.array(timelineItemSchema).min(1),
    }),
    seconds: z.int().min(4).max(30),
  })
  .superRefine((shot, ctx) => {
    const checkReferences = (text: string, path: (string | number)[]) => {
      const invalid = extractImageIndexes(text).find(
        (number) => number < 1 || number > shot.image_urls.length,
      )
      if (invalid !== undefined) {
        ctx.addIssue({
          code: 'custom',
          message:
            shot.image_urls.length === 0
              ? `本组没有图片，请添加图片或移除 @Image${invalid} 引用`
              : `@Image${invalid} 超出本组的 ${shot.image_urls.length} 张图片`,
          path,
        })
      }
    }
    checkReferences(shot.prompt.global_settings, ['prompt', 'global_settings'])
    let previousEnd = 0
    for (const [position, item] of shot.prompt.timeline.entries()) {
      const [start, end] = item.timestamps
      if (end <= start || (position === 0 && start !== 0) || start < previousEnd) {
        ctx.addIssue({
          code: 'custom',
          message: '镜头时间范围或顺序不正确',
          path: ['prompt', 'timeline', position, 'timestamps'],
        })
      }
      checkReferences(item.prompt, ['prompt', 'timeline', position, 'prompt'])
      if (
        item.image_indexes.some((number) => number > shot.image_urls.length) ||
        new Set(item.image_indexes).size !== item.image_indexes.length
      ) {
        ctx.addIssue({
          code: 'custom',
          message: '镜头的图片编号无效',
          path: ['prompt', 'timeline', position, 'image_indexes'],
        })
      }
      const expected = extractImageIndexes(item.prompt)
      if (
        expected.length !== item.image_indexes.length ||
        expected.some((number, index) => number !== item.image_indexes[index])
      ) {
        ctx.addIssue({
          code: 'custom',
          message: '图片编号必须与正文中的引用顺序一致',
          path: ['prompt', 'timeline', position, 'image_indexes'],
        })
      }
      previousEnd = end
    }
  })

const shotsDocumentSchema = z
  .strictObject({
    aspect_ratio: nonblank,
    shots: z.array(shotSchema).min(1),
  })
  .superRefine((document, ctx) => {
    for (const [position, shot] of document.shots.entries()) {
      if (shot.index !== position + 1) {
        ctx.addIssue({
          code: 'custom',
          message: '镜头组编号必须从 1 连续排列',
          path: ['shots', position, 'index'],
        })
      }
    }
  })

export type Shot = z.infer<typeof shotSchema>
export type ShotsDocument = z.infer<typeof shotsDocumentSchema>

export const parseShotsDocument = (content: string): ShotsDocument | null => {
  let raw: unknown
  try {
    raw = JSON.parse(content)
  } catch {
    return null
  }
  const result = shotsDocumentSchema.safeParse(raw)
  return result.success ? result.data : null
}

/** 草稿可以暂时不合法；保存边界使用同一文档校验并返回可显示的原因。 */
export const validateShot = (shot: Shot): string | undefined => {
  const result = shotSchema.safeParse(shot)
  if (result.success) return undefined
  const issue = result.error.issues[0]
  if (issue === undefined) return '镜头组格式不正确'
  const position = issue.path[1] === 'timeline' ? issue.path[2] : undefined
  const where =
    typeof position === 'number'
      ? `镜头组 ${shot.index} 的第 ${position + 1} 镜`
      : `镜头组 ${shot.index}`
  return `${where}：${issue.message}`
}

export const validateShotsDocument = (document: ShotsDocument): string | undefined => {
  const result = shotsDocumentSchema.safeParse(document)
  if (result.success) return undefined
  const issue = result.error.issues[0]
  const position = issue?.path[0] === 'shots' ? issue.path[1] : undefined
  const shot = typeof position === 'number' ? document.shots[position] : undefined
  return (shot === undefined ? undefined : validateShot(shot)) ?? issue?.message ?? '分镜格式不正确'
}

export type PromptInsertion = { text: string; start: number; end: number }

export const updateTimelinePrompt = (shot: Shot, position: number, prompt: string): Shot => {
  if (shot.prompt.timeline[position] === undefined) throw new Error('这个镜头已不存在，请重新选择')
  return {
    ...shot,
    prompt: {
      ...shot.prompt,
      timeline: shot.prompt.timeline.map((item, index) =>
        index === position ? { ...item, prompt, image_indexes: extractImageIndexes(prompt) } : item,
      ),
    },
  }
}

/** 有效选区内插入引用；文本已经变化或未指定选区时追加末尾。 */
const insertReferenceText = (
  prompt: string,
  number: number,
  insertion?: PromptInsertion,
): string => {
  const reference = `@Image${number}`
  if (
    insertion?.text === prompt &&
    Number.isInteger(insertion.start) &&
    Number.isInteger(insertion.end) &&
    insertion.start >= 0 &&
    insertion.end >= insertion.start &&
    insertion.end <= prompt.length
  ) {
    return prompt.slice(0, insertion.start) + reference + prompt.slice(insertion.end)
  }
  return prompt + (prompt.length === 0 || /\s$/.test(prompt) ? '' : ' ') + reference
}

export const insertFrameReference = (
  shot: Shot,
  position: number,
  number: number,
  insertion?: PromptInsertion,
): Shot => {
  const item = shot.prompt.timeline[position]
  if (item === undefined) throw new Error('这个镜头已不存在，请重新选择')
  if (!Number.isInteger(number) || number < 1 || number > shot.image_urls.length) {
    throw new Error('这张图片已不存在，请重新选择')
  }
  return updateTimelinePrompt(shot, position, insertReferenceText(item.prompt, number, insertion))
}

/** 新图只追加，正文引用和派生编号在同一个草稿操作中更新。 */
export const appendShotFrame = (
  shot: Shot,
  position: number,
  url: string,
  insertion?: PromptInsertion,
): Shot => {
  if (url.trim() === '') throw new Error('图片地址不能为空')
  const images = [...shot.image_urls, url]
  return insertFrameReference({ ...shot, image_urls: images }, position, images.length, insertion)
}

export const formatShotPrompt = (shot: Shot): string =>
  [
    shot.prompt.global_settings,
    ...shot.prompt.timeline.map(
      (item, index) =>
        `[${item.timestamps[0]}–${item.timestamps[1]}秒｜镜头${index + 1}]\n${item.prompt}`,
    ),
  ].join('\n\n')

export const formatShotPrompts = (shots: readonly Shot[]): string =>
  shots.map((shot) => `镜头组 ${shot.index}\n${formatShotPrompt(shot)}`).join('\n\n')

/** 镜头边界和图片归属直接取文件字段；文本分段只供行内帧标记展示。 */
export const splitShotTimeline = (shot: Shot): ShotTimeline => ({
  preamble: shot.prompt.global_settings,
  scenes: shot.prompt.timeline.map((item, position) => ({
    endSeconds: item.timestamps[1],
    frameNumbers: [...item.image_indexes],
    id: position.toString(),
    scene: position + 1,
    segments: splitPrompt(item.prompt),
    startSeconds: item.timestamps[0],
  })),
})

const SENTENCE_END = /[。；！？!?;]/

/** 只读标题从镜头正文取首句，文件中的正文保持原样。 */
export const promptTitle = (prompt: string): string | undefined => {
  const firstLine = prompt
    .split('\n')
    .map((line) =>
      line
        .replace(FRAME_REF, '')
        .replace(/\s+([，。；！？、,.;!?])/g, '$1')
        .replace(/\s{2,}/g, ' ')
        .trim(),
    )
    .find((line) => line.length > 0)
  if (firstLine === undefined) return undefined
  const sentence = firstLine.split(SENTENCE_END)[0]?.trim() ?? ''
  return sentence.length === 0 ? firstLine : sentence
}

export const shotName = (shot: Shot): string =>
  promptTitle(shot.prompt.timeline[0]?.prompt ?? '') ?? `镜头组 ${shot.index}`

export { firstFrameOfScene, sceneOfFrame } from './shots'
