import { z } from 'zod'
import { MAX_EDIT_REFERENCES } from '../generation-limits'
import type { FrameEditDraft, FrameEditTarget } from './image-edit-types'

// 编辑器内部的形状，不进 HTTP：提交时只发编译好的 prompt 与图片地址。
const idSchema = z.string().min(1).max(100)
const urlSchema = z.string().min(1).max(4096)
const draftSchema = z.object({
  annotations: z
    .array(
      z.object({
        id: idSchema,
        number: z.int().min(1).max(9999),
        kind: z.enum(['point', 'rectangle', 'ellipse', 'arrow', 'pen']),
        points: z
          .array(z.object({ x: z.number(), y: z.number() }))
          .min(1)
          .max(2000),
      }),
    )
    .max(50),
  instructions: z.array(
    z.union([
      z.object({ kind: z.literal('text'), text: z.string() }),
      z.object({ kind: z.literal('annotation'), id: idSchema }),
      z.object({ kind: z.literal('referenceImage'), id: idSchema }),
    ]),
  ),
  references: z
    .array(
      z.object({
        id: idSchema,
        url: urlSchema,
        kind: z.enum(['image', 'annotated']),
        label: z.string().min(1).max(200),
      }),
    )
    .max(MAX_EDIT_REFERENCES),
})

/** 一格上每张底图各一份草稿：圈画在哪张图上，修改要求里的芯片就指着那张图上的圈。
 * 换底图等于换一套输入，不能混用。 */
const draftsSchema = z.record(urlSchema, draftSchema)

export type FrameEditDrafts = z.infer<typeof draftsSchema>

/** 底图在图片列表里的固定身份：空草稿要能反复算出同一份，芯片才不会每次渲染换个指向。 */
const BASE_REFERENCE_ID = 'base'

export const emptyEditDraft = (baseUrl: string): FrameEditDraft => ({
  annotations: [],
  instructions: [],
  references: [{ id: BASE_REFERENCE_ID, kind: 'image', url: baseUrl, label: '编辑底图' }],
})

/** 草稿按格存，不按底图地址：应用之后这一格换了图，别的底图上没提交完的输入还在。 */
export const editDraftKey = (target: FrameEditTarget) =>
  `cue:frame-edit:${target.conversationId}:${target.shotIndex}:${target.frameNumber}`

export function loadEditDrafts(target: FrameEditTarget): FrameEditDrafts {
  const raw = sessionStorage.getItem(editDraftKey(target))
  if (raw === null) return {}
  const parsed = draftsSchema.safeParse(JSON.parse(raw))
  if (!parsed.success) throw new Error('本地图片编辑草稿无法读取')
  return parsed.data
}

/** 取这张底图的草稿；没写过就现开一份，图片列表里先放上底图自己。
 * 存着的那份被删空了图片也把底图带回来，不然恢复出来的草稿提交不了。 */
export function draftOf(drafts: FrameEditDrafts, baseUrl: string): FrameEditDraft {
  const stored = drafts[baseUrl]
  if (stored === undefined) return emptyEditDraft(baseUrl)
  return stored.references.length === 0
    ? { ...stored, references: emptyEditDraft(baseUrl).references }
    : stored
}

/** 只有仍使用底图的默认输入可省略；尚未填写要求的替代参考图也属于用户草稿。 */
export const isEmptyDraft = (draft: FrameEditDraft, baseUrl: string): boolean =>
  draft.annotations.length === 0 &&
  draft.instructions.length === 0 &&
  draft.references.length === 1 &&
  draft.references[0]?.kind === 'image' &&
  draft.references[0].url === baseUrl

export function editDraftError(draft: FrameEditDraft): string | null {
  if (draft.annotations.length > 50) return '每张图片最多添加 50 个标注'
  if (draft.annotations.reduce((total, annotation) => total + annotation.points.length, 0) > 10000)
    return '标注点数过多，请简化画笔标注'
  if (draft.instructions.length > 200) return '引用片段过多，请简化修改要求'
  if (
    draft.instructions.reduce(
      (total, part) => total + (part.kind === 'text' ? part.text.length : 0),
      0,
    ) > 4000
  )
    return '修改要求不能超过 4000 字'

  if (draft.references.length === 0) return '请先选择要提交给模型的图片'
  if (draft.references.length > MAX_EDIT_REFERENCES)
    return `每次最多提交 ${MAX_EDIT_REFERENCES} 张图片`
  if (draft.instructions.every((part) => part.kind === 'text' && part.text.trim() === ''))
    return '请填写修改要求'
  for (const part of draft.instructions) {
    if (part.kind === 'annotation') {
      if (!draft.annotations.some((annotation) => annotation.id === part.id))
        return '修改要求中有已删除的标注，请处理失效引用'
      if (!draft.references.some((reference) => reference.kind === 'annotated'))
        return '引用标注时，请在图片列表中加入标注图'
    }
    if (
      part.kind === 'referenceImage' &&
      !draft.references.some((reference) => reference.id === part.id)
    )
      return '修改要求中有已移除的图片，请处理失效引用'
  }
  return null
}
