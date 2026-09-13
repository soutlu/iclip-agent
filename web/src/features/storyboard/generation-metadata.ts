/** 分镜页写进生成任务 `metadata` 的坐标；服务端只存不读，形状在这里定义并校验（ADR-0020）。 */

import { z } from 'zod'

const storyboardMetadataSchema = z.object({
  path: z.string().min(1),
  shot: z.int().positive(),
  frame: z.int().positive().optional(),
  /** 图片编辑这次改的是哪张图。存量记录没有，读不出就当不知道。 */
  sourceUrl: z.string().min(1).optional(),
})

export type StoryboardMetadata = z.infer<typeof storyboardMetadataSchema>

/** 提交时写进请求体的坐标；视频出片按镜头组，不带 frame。 */
export const storyboardMetadata = (
  path: string,
  shot: number,
  frame?: number,
): StoryboardMetadata => (frame === undefined ? { path, shot } : { frame, path, shot })

/** 图片编辑的坐标：除了这一格，还记下这次改的是哪张图。
 *
 * 底图不一定还在分镜里——它可能是上一轮没落盘的编辑结果，也可能已经被后来的编辑覆盖。
 * 记下来，这一帧出现过的图才能从任务列表里重新拼出来。筛选时不带这一项。 */
export const frameEditMetadata = (
  path: string,
  shot: number,
  frame: number,
  sourceUrl: string,
): StoryboardMetadata => ({ ...storyboardMetadata(path, shot, frame), sourceUrl })

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
