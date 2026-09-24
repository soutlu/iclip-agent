/** 镜头组可选择的内容；内容身份独立于它引用的图片。 */
import { z } from 'zod'
import { UserFacingError } from '@/shared/api/client'
import { MAX_REFERENCE_IMAGES } from './shots'
import {
  extractImageIndexes,
  promptTitle,
  updateTimelinePrompt,
  insertReferenceText,
  type PromptInsertion,
  type Shot,
} from './shot-document'

/** 内容身份：全局设定、第 n 镜，或未被任何正文引用的图片。 */
export type ShotContentRef =
  { kind: 'global' } | { kind: 'scene'; scene: number } | { kind: 'unreferenced' }

const SCENE_ID = /^scene:([1-9]\d*)$/

/** 查询参数与 DOM key 用的字符串形式。 */
export const encodeContentId = (ref: ShotContentRef): string =>
  ref.kind === 'scene' ? `scene:${ref.scene}` : ref.kind

/** 解析字符串形式；不合法返回 undefined。 */
export const decodeContentId = (id: string): ShotContentRef | undefined => {
  if (id === 'global' || id === 'unreferenced') return { kind: id }
  const match = SCENE_ID.exec(id)
  return match ? { kind: 'scene', scene: Number(match[1]) } : undefined
}

/** 路由查询参数里的内容 id。 */
export const shotContentIdSchema = z
  .string()
  .refine((id) => decodeContentId(id) !== undefined, '内容 id 不合法')

/** 路由查询参数里盖在分镜页上的那一层：全部镜头组、完整提示词或生成记录。 */
export const readerSheetSchema = z.enum(['all', 'prompt', 'records'])

export type ShotContent = {
  id: string
  kind: ShotContentRef['kind']
  title: string
  frameNumbers: number[]
  prompt?: string
  timelineIndex?: number
  seconds?: number
}

export const shotContents = (shot: Shot): [ShotContent, ...ShotContent[]] => {
  const valid = (numbers: number[]) => numbers.filter((n) => n >= 1 && n <= shot.image_urls.length)
  const contents: [ShotContent, ...ShotContent[]] = [
    {
      id: encodeContentId({ kind: 'global' }),
      kind: 'global',
      title: '全局设定',
      prompt: shot.prompt.global_settings,
      frameNumbers: valid(extractImageIndexes(shot.prompt.global_settings)),
    },
    ...shot.prompt.timeline.map((item, index) => ({
      id: encodeContentId({ kind: 'scene', scene: index + 1 }),
      kind: 'scene' as const,
      title: promptTitle(item.prompt) ?? `镜头 ${index + 1}`,
      prompt: item.prompt,
      timelineIndex: index,
      seconds: item.timestamps[1] - item.timestamps[0],
      frameNumbers: valid(item.image_indexes),
    })),
  ]
  const used = new Set(contents.flatMap((item) => item.frameNumbers))
  const unused = shot.image_urls.flatMap((_, index) => (used.has(index + 1) ? [] : [index + 1]))
  if (unused.length > 0)
    contents.push({
      id: encodeContentId({ kind: 'unreferenced' }),
      kind: 'unreferenced',
      title: '未引用',
      frameNumbers: unused,
    })
  return contents
}

/** 查询参数指的内容与帧：内容指不到落回首项，帧不属于该内容落回它的首帧，内容没有帧时为 undefined。 */
export const resolveShotSelection = (
  contents: readonly [ShotContent, ...ShotContent[]],
  wanted: { content: string | undefined; frame: number | undefined },
): { content: ShotContent; frame: number | undefined } => {
  const content = contents.find((item) => item.id === wanted.content) ?? contents[0]
  const frame =
    wanted.frame !== undefined && content.frameNumbers.includes(wanted.frame)
      ? wanted.frame
      : content.frameNumbers[0]
  return { content, frame }
}

/** 导航、选区与可访问名里的短名：镜头按序号叫「镜头 N」，全局设定与未引用用标题。 */
export const contentLabel = (content: ShotContent): string =>
  content.timelineIndex === undefined ? content.title : `镜头 ${content.timelineIndex + 1}`

export const updateContentPrompt = (shot: Shot, id: string, text: string): Shot => {
  const content = shotContents(shot).find((item) => item.id === id)
  if (content?.kind === 'global')
    return { ...shot, prompt: { ...shot.prompt, global_settings: text } }
  if (content?.timelineIndex !== undefined)
    return updateTimelinePrompt(shot, content.timelineIndex, text)
  throw new UserFacingError('请先选择全局设定或镜头')
}

/** 在指定正文插入图片引用；已有编号保持不变。 */
export const insertContentReference = (
  shot: Shot,
  id: string,
  number: number,
  insertion?: PromptInsertion,
): Shot => {
  const content = shotContents(shot).find((item) => item.id === id)
  if (content?.prompt === undefined) throw new UserFacingError('请先选择全局设定或镜头')
  if (!Number.isInteger(number) || number < 1 || number > shot.image_urls.length)
    throw new UserFacingError('这张图片已不存在，请重新选择')
  return updateContentPrompt(shot, id, insertReferenceText(content.prompt, number, insertion))
}

/** 新图与正文引用在同一次草稿更新中落下；达到上限仍可关联已有图片。 */
export const appendContentImage = (
  shot: Shot,
  id: string,
  url: string,
  insertion?: PromptInsertion,
): Shot => {
  if (shot.image_urls.length >= MAX_REFERENCE_IMAGES)
    throw new UserFacingError(`每组最多使用 ${MAX_REFERENCE_IMAGES} 张参考图`)
  if (url.trim() === '') throw new UserFacingError('图片地址不能为空')
  const image_urls = [...shot.image_urls, url]
  return insertContentReference({ ...shot, image_urls }, id, image_urls.length, insertion)
}
