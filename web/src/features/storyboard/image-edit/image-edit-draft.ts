import { z } from 'zod'
import type { FrameEditDraft, FrameEditTarget } from './image-edit-types'

// 编辑器内部的形状，不进 HTTP：提交时只发编译好的 prompt 与图片地址。
const idSchema = z.string().min(1).max(100)
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
        url: z.string().min(1).max(4096),
        kind: z.enum(['image', 'annotated']),
        label: z.string().min(1).max(200),
      }),
    )
    .max(10),
})

export const emptyEditDraft = (): FrameEditDraft => ({
  annotations: [],
  instructions: [],
  references: [],
})
export const editDraftKey = (target: FrameEditTarget) => `cue:frame-edit:${JSON.stringify(target)}`
export function loadEditDraft(target: FrameEditTarget): FrameEditDraft {
  const raw = sessionStorage.getItem(editDraftKey(target))
  if (raw === null) return emptyEditDraft()
  const parsed = draftSchema.safeParse(JSON.parse(raw))
  if (!parsed.success) throw new Error('本地图片编辑草稿无法读取')
  return parsed.data
}

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
  if (draft.references.length > 10) return '每次最多提交 10 张图片'
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
