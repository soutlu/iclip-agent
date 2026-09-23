/** 分镜页写进生成任务 `metadata` 的坐标；形状在这里定义并校验。
 * 服务端只认其中的 `shot`（审计按它数镜），其余键只有本页读写。 */

import { z } from 'zod'

const storyboardMetadataSchema = z.object({
  shot: z.int().positive(),
  frame: z.int().positive().optional(),
  /** 图片编辑这次改的是哪张图。存量记录没有，读不出就当不知道。 */
  sourceUrl: z.string().min(1).optional(),
})

export type StoryboardMetadata = z.infer<typeof storyboardMetadataSchema>

/** 提交时写进请求体的坐标；视频出片按镜头组，不带 frame。 */
export const storyboardMetadata = (shot: number, frame?: number): StoryboardMetadata =>
  frame === undefined ? { shot } : { frame, shot }

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

/** 视频编辑链的坐标。三条记录（参考片段、编辑结果、成片）共用同一组键，靠 `editId` 串成一次编辑；
 * 它们属于哪条出片不在便签上，在记录的 `rootJobId` 里，链查询也按它筛。
 *
 * 便签里不放记录 id：分叉会把整条链拷进副本、记录全换新 id，便签上的 id 会失效。基于哪一版
 * 用那一版的 `editId` 指，它是前端铸的、拷贝时原样带过去。
 * 不带 `shot`：编辑结果不是这一镜的出片，抽屉与审计都不该把它算进去。
 * `editStart` 在编辑结果与成片上记的是实际值——参考片段按关键帧切，起点会落在用户选的位置之前，
 * 提交编辑任务那一刻按片段实际时长反算出来写进去；合成只读它，不回头碰会过期的参考片段。 */
const videoEditMetadataSchema = z.object({
  /** 这次编辑基于哪一版：那一版成片的 `editId`；基于原片就不填。 */
  baseEdit: z.string().min(1).optional(),
  editId: z.string().min(1),
  editStart: z.number().min(0),
  editEnd: z.number().positive(),
})

export type VideoEditMetadata = z.infer<typeof videoEditMetadataSchema>

export const readVideoEditMetadata = (job: {
  metadata: Record<string, unknown> | null
}): VideoEditMetadata | undefined => {
  const parsed = videoEditMetadataSchema.safeParse(job.metadata)
  return parsed.success ? parsed.data : undefined
}

/** 列表接口的 `metadata` 查询参数：一段 JSON 对象，服务端按包含匹配筛。 */
export const metadataFilterParam = (filter: Partial<StoryboardMetadata>): string =>
  JSON.stringify(filter)
