import { z } from 'zod'

const editorSourceSchema = z.object({
  jobId: z.string().min(1),
  videoUrl: z.string().trim().min(1),
  posterUrl: z.string().min(1).optional(),
  title: z.string().min(1),
  returnTo: z.string().refine((path) => path.startsWith('/') && !path.startsWith('//')),
})

export type EditorSource = z.infer<typeof editorSourceSchema>

const sourceKey = (jobId: string) => `cue:video-editor:source:${jobId}`

/** 在当前标签页保留原片与返回位置；存储失败向调用方抛错。 */
export function saveEditorSource(source: EditorSource): void {
  const parsed = editorSourceSchema.parse(source)
  sessionStorage.setItem(sourceKey(parsed.jobId), JSON.stringify(parsed))
}

/** 没有来源时返回 undefined；已存内容损坏或存储不可读时抛错。 */
export function loadEditorSource(jobId: string): EditorSource | undefined {
  const raw = sessionStorage.getItem(sourceKey(jobId))
  if (raw === null) return undefined
  const source = editorSourceSchema.parse(JSON.parse(raw))
  if (source.jobId !== jobId) throw new Error('视频编辑来源不匹配')
  return source
}
