/** 分镜页写进生成任务 `metadata` 的坐标；服务端只存不读，形状在这里定义并校验（ADR-0020）。 */

import { z } from 'zod'

const storyboardMetadataSchema = z.object({
  path: z.string().min(1),
  shot: z.int().positive(),
  frame: z.int().positive().optional(),
})

export type StoryboardMetadata = z.infer<typeof storyboardMetadataSchema>

/** 提交时写进请求体的坐标；视频出片按镜头组，不带 frame。 */
export const storyboardMetadata = (
  path: string,
  shot: number,
  frame?: number,
): StoryboardMetadata => (frame === undefined ? { path, shot } : { frame, path, shot })

/** 记录里的坐标；不是分镜页写的形状（别的调用方写的、或没写）就当没有坐标。 */
export const readStoryboardMetadata = (job: {
  metadata: Record<string, unknown> | null
}): StoryboardMetadata | undefined => {
  const parsed = storyboardMetadataSchema.safeParse(job.metadata)
  return parsed.success ? parsed.data : undefined
}

/** 列表接口的 `metadata` 查询参数：一段 JSON 对象，服务端按包含匹配筛。 */
export const metadataFilterParam = (filter: Partial<StoryboardMetadata>): string =>
  JSON.stringify(filter)
