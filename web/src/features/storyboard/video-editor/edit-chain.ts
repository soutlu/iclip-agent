/** 编辑链的投影：一条出片名下的编辑段与合成 → 可播放的版本 + 进行中的编辑。纯函数，不持有状态，刷新即恢复。 */

import { isRunningStatus } from '../shots'
import type { GenerationJob } from '../storyboard.api'

/** 播放器里连着放的一段：从 `mediaUrl` 的 `start` 放到 `end`；`end` 省略即放到素材结束。 */
export type PlaySegment = {
  mediaUrl: string
  start: number
  end?: number
  role: 'base' | 'edited'
}

/** 排好时钟的一段：`at` 是它在整条预览里的起点。 */
export type LaidOutSegment = PlaySegment & { at: number; duration: number; end: number }

/** 编辑段改的那一段，单位秒；记的是服务端实际切下的区间，不是用户选的。 */
export type EditRange = { start: number; end: number }

/** 一条完整视频：根出片或某次合成。切段只在它上面切。 */
export type ChainVersion = {
  /** 根用记录 id；合成用它来源编辑段的 id，和合成前那条编辑同键，选中态跨过合成不会跳走。 */
  key: string
  /** 这一版自己的记录：根就是根，合成是合成那行。下一次编辑以它为基底。 */
  jobId: string
  label: string
  mediaUrl: string
  createdAt: string
  /** 这版基于哪一版、改了哪一段；根没有。 */
  edit: (EditRange & { baseKey: string }) | undefined
}

export type EditStage =
  /** 编辑段在排队，或服务端正在切参考片段、交给模型。 */
  | 'cutting'
  | 'generating'
  /** 编辑结果回来了，可以预览、可以合成。 */
  | 'ready'
  | 'composing'
  | 'failed'

/** 各阶段给人看的词；版本菜单里在途编辑的备注用它。 */
export const EDIT_STAGE_LABEL: Record<EditStage, string> = {
  cutting: '切片中',
  generating: '生成中',
  ready: '待预览',
  composing: '合成中',
  failed: '失败',
}

export type PendingEdit = {
  /** 编辑段的记录 id。 */
  key: string
  /** 合成后会成为第几版；提交时就先叫这个名，和以前的任务列表一致。 */
  label: string
  base: ChainVersion
  stage: EditStage
  range: EditRange
  prompt: string | undefined
  error: string | undefined
  /** 这次编辑的编辑段。 */
  video: GenerationJob
  /** 它最新的那次合成；还没合成过就没有。 */
  composite: GenerationJob | undefined
  /** 基底切开、夹进编辑结果；结果还没回来时没有。 */
  preview: PlaySegment[] | undefined
}

export type EditChain = { versions: ChainVersion[]; pending: PendingEdit[] }

type EditSegment = GenerationJob & { sourceJobId: string; rangeStartMs: number; rangeEndMs: number }
type Composite = GenerationJob & { sourceJobId: string }

/** 编辑段：基于一条成片调模型改一段。来源与区间由服务端定、一定成对出现。 */
export const isEditSegment = (job: GenerationJob): job is EditSegment =>
  job.kind === 'video' &&
  job.operation === 'generate' &&
  job.sourceJobId != null &&
  job.rangeStartMs != null &&
  job.rangeEndMs != null

/** 合成：把一条编辑段按它的基底与区间拼成新的一版，来源是那条编辑段。 */
export const isComposite = (job: GenerationJob): job is Composite =>
  job.operation === 'compose' && job.sourceJobId != null

const rangeOf = (segment: EditSegment): EditRange => ({
  start: segment.rangeStartMs / 1000,
  end: segment.rangeEndMs / 1000,
})

const promptOf = (job: GenerationJob): string | undefined => {
  const prompt = job.request['prompt']
  return typeof prompt === 'string' ? prompt : undefined
}

const byCreation = (left: GenerationJob, right: GenerationJob): number =>
  Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.id.localeCompare(right.id)

/** 成片按到终态的时刻排；缺了这个时刻就退回创建时刻。 */
const byFinish = (left: GenerationJob, right: GenerationJob): number =>
  Date.parse(left.finishedAt ?? left.createdAt) - Date.parse(right.finishedAt ?? right.createdAt) ||
  left.id.localeCompare(right.id)

/** 每条编辑段只认最近发起的那次合成：重新合成过，之前那次就不再算数。按发起时刻比，
 * 在跑的那次还没有完成时刻。 */
const latestComposites = (jobs: readonly GenerationJob[]): ReadonlyMap<string, Composite> => {
  const latest = new Map<string, Composite>()
  for (const job of jobs) {
    if (!isComposite(job)) continue
    const current = latest.get(job.sourceJobId)
    if (current === undefined || byCreation(job, current) > 0) latest.set(job.sourceJobId, job)
  }
  return latest
}

const stageOf = (
  segment: GenerationJob,
  composite: GenerationJob | undefined,
): { stage: EditStage; error: string | undefined } => {
  if (composite !== undefined) {
    if (isRunningStatus(composite.status)) return { stage: 'composing', error: undefined }
    if (composite.status !== 'completed')
      return { stage: 'failed', error: composite.errorMessage ?? '合成失败' }
  }
  if (segment.status === 'completed' && segment.outputUrl !== null)
    return { stage: 'ready', error: undefined }
  if (segment.status === 'pending' || segment.status === 'submitting')
    return { stage: 'cutting', error: undefined }
  if (segment.status === 'submitted') return { stage: 'generating', error: undefined }
  return { stage: 'failed', error: segment.errorMessage ?? '生成失败' }
}

/** 基底切开、把编辑结果夹进去。基底是一条完整视频，所以最多三段、两个地址。 */
export const splicePreview = (
  base: ChainVersion,
  range: EditRange,
  editedUrl: string,
): PlaySegment[] => {
  const segments: PlaySegment[] = []
  if (range.start > 0)
    segments.push({ mediaUrl: base.mediaUrl, start: 0, end: range.start, role: 'base' })
  segments.push({ mediaUrl: editedUrl, start: 0, role: 'edited' })
  segments.push({ mediaUrl: base.mediaUrl, start: range.end, role: 'base' })
  return segments
}

/** 版本与进行中的编辑。`jobs` 是链查询拿回来的（这条出片名下的编辑段与合成），根自己不在里面，单独传。
 *
 * 完成的合成按完成时刻编 V2、V3……；基底一律按记录 id 找，基底不在链里的编辑无处安放，不展示。 */
export const projectEditChain = (
  root: GenerationJob,
  jobs: readonly GenerationJob[],
): EditChain => {
  // 根没出片就没有可切的东西，链上别的记录也无处安放。
  if (root.outputUrl === null) return { versions: [], pending: [] }
  const segments = jobs.filter(isEditSegment)
  const composites = latestComposites(jobs)
  const versions: ChainVersion[] = [
    {
      key: root.id,
      jobId: root.id,
      label: 'V1',
      mediaUrl: root.outputUrl,
      createdAt: root.createdAt,
      edit: undefined,
    },
  ]
  const composed = segments
    .flatMap((segment) => {
      const composite = composites.get(segment.id)
      return composite?.status === 'completed' && composite.outputUrl !== null
        ? [{ segment, composite, mediaUrl: composite.outputUrl }]
        : []
    })
    .sort((left, right) => byFinish(left.composite, right.composite))
  // 基底先于基于它的合成完成，按完成时刻走一遍，找基底时它已经在列表里了。
  for (const { segment, composite, mediaUrl } of composed) {
    const base = versions.find((version) => version.jobId === segment.sourceJobId)
    if (base === undefined) continue
    versions.push({
      key: segment.id,
      jobId: composite.id,
      label: `V${versions.length + 1}`,
      mediaUrl,
      createdAt: composite.createdAt,
      edit: { ...rangeOf(segment), baseKey: base.key },
    })
  }

  const pending: PendingEdit[] = []
  for (const segment of segments) {
    if (composed.some((item) => item.segment === segment)) continue
    const base = versions.find((version) => version.jobId === segment.sourceJobId)
    if (base === undefined) continue
    const composite = composites.get(segment.id)
    const range = rangeOf(segment)
    const { stage, error } = stageOf(segment, composite)
    pending.push({
      key: segment.id,
      label: '',
      base,
      stage,
      range,
      prompt: promptOf(segment),
      error,
      video: segment,
      composite,
      preview:
        segment.outputUrl === null ||
        (stage !== 'ready' && stage !== 'composing' && stage !== 'failed')
          ? undefined
          : splicePreview(base, range, segment.outputUrl),
    })
  }
  pending.sort((left, right) => byCreation(left.video, right.video))
  return {
    versions,
    pending: pending.map((edit, at) => ({ ...edit, label: `V${versions.length + at + 1}` })),
  }
}

/** 从某一版往上追到根：每一版都记着基于哪一版。 */
export const ancestorsOf = (
  versions: readonly ChainVersion[],
  from: ChainVersion,
): ChainVersion[] => {
  const chain: ChainVersion[] = []
  const seen = new Set<string>()
  let current: ChainVersion | undefined = from
  while (current !== undefined && !seen.has(current.key)) {
    chain.push(current)
    seen.add(current.key)
    const baseKey: string | undefined = current.edit?.baseKey
    current = versions.find((version) => version.key === baseKey)
  }
  return chain.reverse()
}

/** 已知各素材的时长，就能把各段排上时钟；有一段开放着又不知道时长，就还排不出来。 */
export const layoutSegments = (
  segments: readonly PlaySegment[],
  durations: Readonly<Record<string, number | null | undefined>>,
): LaidOutSegment[] | undefined => {
  const laid: LaidOutSegment[] = []
  let at = 0
  for (const segment of segments) {
    const end = segment.end ?? durations[segment.mediaUrl] ?? undefined
    if (end === undefined || end === null) return undefined
    const duration = Math.max(0, end - segment.start)
    if (duration === 0) continue
    laid.push({ ...segment, at, duration, end })
    at += duration
  }
  return laid
}

export const totalDuration = (segments: readonly LaidOutSegment[]): number =>
  segments.reduce((sum, segment) => sum + segment.duration, 0)

/** 时钟落在哪一段、段内偏移多少；超出末尾就是最后一段的结尾。 */
export const locateClock = (
  segments: readonly LaidOutSegment[],
  clock: number,
): { index: number; offset: number } | undefined => {
  if (segments.length === 0) return undefined
  if (clock < 0) return { index: 0, offset: 0 }
  const index = segments.findIndex(
    (segment) => clock >= segment.at && clock < segment.at + segment.duration,
  )
  const hit = segments[index]
  if (hit !== undefined) return { index, offset: clock - hit.at }
  const last = segments.length - 1
  return { index: last, offset: segments[last]?.duration ?? 0 }
}

/** 每条根被成功编辑过几次，给抽屉那张卡显示：数它名下已完成的编辑段。合成是同一次编辑拼出来的，不另算。 */
export const editCountsByRoot = (jobs: readonly GenerationJob[]): ReadonlyMap<string, number> => {
  const counts = new Map<string, number>()
  for (const job of jobs) {
    if (!isEditSegment(job) || job.status !== 'completed' || job.rootJobId === null) continue
    counts.set(job.rootJobId, (counts.get(job.rootJobId) ?? 0) + 1)
  }
  return counts
}
