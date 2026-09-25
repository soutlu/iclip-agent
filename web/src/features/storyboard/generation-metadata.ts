/** 分镜页写进图片生成任务 `metadata` 的坐标 `{shot, frame}`；形状在这里定义并校验。
 * 服务端不读也不解释 `metadata`，这些键只有本页读写。视频的镜号在 `shotIndex` 上，不写这里。 */

import { z } from 'zod'

const storyboardMetadataSchema = z.object({
  shot: z.int().positive(),
  frame: z.int().positive().optional(),
  /** 图片编辑这次改的是哪张图。存量记录没有，读不出就当不知道。 */
  sourceUrl: z.string().min(1).optional(),
})

export type StoryboardMetadata = z.infer<typeof storyboardMetadataSchema>

/** 图片任务落在哪一格：第几镜头组的第几帧。 */
export const storyboardMetadata = (shot: number, frame: number): StoryboardMetadata => ({
  frame,
  shot,
})

/** 图片编辑的坐标：除了这一格，还记下这次改的是哪张图。
 *
 * 底图不一定还在分镜里——它可能是上一轮没落盘的编辑结果，也可能已经被后来的编辑覆盖。
 * 记下来，这一帧出现过的图才能从任务列表里重新拼出来。筛选时不带这一项。 */
export const frameEditMetadata = (
  shot: number,
  frame: number,
  sourceUrl: string,
): StoryboardMetadata => ({ ...storyboardMetadata(shot, frame), sourceUrl })

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
