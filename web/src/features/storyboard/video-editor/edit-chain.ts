/** 编辑链的投影：一串生成记录 → 可播放的版本 + 进行中的编辑。纯函数，不持有状态，刷新即恢复。 */

import { zClipIn } from '@/shared/api/generated/zod.gen'
import { readVideoEditMetadata, type VideoEditMetadata } from '../generation-metadata'
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

/** 一条完整视频：根出片或某条成片。切段只在它上面切。 */
export type ChainVersion = {
  /** 根用记录 id；成片用 editId，和合成前那条编辑同键，选中态跨过合成不会跳走。 */
  key: string
  jobId: string
  label: string
  mediaUrl: string
  createdAt: string
  /** 这版基于哪一版、改了哪一段；根没有。 */
  edit: (VideoEditMetadata & { baseKey: string }) | undefined
}

export type EditStage =
  /** 参考片段在切。 */
  | 'cutting'
  /** 参考片段切好了，编辑任务还没发。只有发起它的这次会话记着草稿，别的会话看不到它。 */
  | 'cut'
  | 'generating'
  /** 编辑结果回来了，可以预览、可以合成。 */
  | 'ready'
  | 'composing'
  | 'failed'

export type PendingEdit = {
  key: string
  /** 合成后会成为第几版；提交时就先叫这个名，和以前的任务列表一致。 */
  label: string
  base: ChainVersion
  stage: EditStage
  coords: VideoEditMetadata
  prompt: string | undefined
  error: string | undefined
  createdAt: string
  reference: GenerationJob | undefined
  video: GenerationJob | undefined
  master: GenerationJob | undefined
  /** 基底切开、夹进编辑结果；结果还没回来时没有。 */
  preview: PlaySegment[] | undefined
}

export type EditChain = { versions: ChainVersion[]; pending: PendingEdit[] }

const clipRequestSchema = zClipIn.pick({ purpose: true, segments: true })

/** 成片与参考片段的 `request`：只剩 purpose 与 segments，归属字段落表时已经剥掉。 */
export const readClipRequest = (job: GenerationJob) => {
  const parsed = clipRequestSchema.safeParse(job.request)
  return parsed.success ? parsed.data : undefined
}

const promptOf = (job: GenerationJob | undefined): string | undefined => {
  const prompt = job?.request['prompt']
  return typeof prompt === 'string' ? prompt : undefined
}

const newest = (jobs: readonly GenerationJob[]): GenerationJob | undefined =>
  [...jobs].sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]

type EditGroup = {
  coords: VideoEditMetadata
  reference: GenerationJob | undefined
  video: GenerationJob | undefined
  master: GenerationJob | undefined
}

/** 按 editId 分组，每种角色只认最新的一条。 */
const groupEdits = (jobs: readonly GenerationJob[]): Map<string, EditGroup> => {
  const buckets = new Map<
    string,
    {
      coords: VideoEditMetadata
      reference: GenerationJob[]
      video: GenerationJob[]
      master: GenerationJob[]
    }
  >()
  for (const job of jobs) {
    const coords = readVideoEditMetadata(job)
    if (coords === undefined) continue
    const bucket = buckets.get(coords.editId) ?? { coords, reference: [], video: [], master: [] }
    if (job.kind === 'video') bucket.video.push(job)
    else if (job.kind === 'clip') {
      const purpose = readClipRequest(job)?.purpose
      if (purpose === 'reference') bucket.reference.push(job)
      else if (purpose === 'master') bucket.master.push(job)
    }
    buckets.set(coords.editId, bucket)
  }
  return new Map(
    [...buckets].map(([editId, bucket]) => [
      editId,
      {
        // 坐标以编辑结果为准：它记的 editStart 是按片段实际时长反算的，参考片段上是用户选的。
        coords:
          readVideoEditMetadata(bucket.video[0] ?? bucket.master[0] ?? { metadata: null }) ??
          bucket.coords,
        reference: newest(bucket.reference),
        video: newest(bucket.video),
        master: newest(bucket.master),
      },
    ]),
  )
}

const stageOf = (group: EditGroup): { stage: EditStage; error: string | undefined } => {
  const { reference, video, master } = group
  if (master !== undefined) {
    if (isRunningStatus(master.status)) return { stage: 'composing', error: undefined }
    if (master.status !== 'completed')
      return { stage: 'failed', error: master.errorMessage ?? '合成失败' }
  }
  if (video !== undefined) {
    if (video.status === 'completed' && video.outputUrl !== null)
      return { stage: 'ready', error: undefined }
    if (isRunningStatus(video.status)) return { stage: 'generating', error: undefined }
    return { stage: 'failed', error: video.errorMessage ?? '生成失败' }
  }
  if (reference !== undefined) {
    if (reference.status === 'completed' && reference.outputUrl !== null)
      return { stage: 'cut', error: undefined }
    if (isRunningStatus(reference.status)) return { stage: 'cutting', error: undefined }
    return { stage: 'failed', error: reference.errorMessage ?? '切片失败' }
  }
  return { stage: 'failed', error: '这次编辑没有留下任何记录' }
}

/** 基底切开、把编辑结果夹进去。基底是一条完整视频，所以最多三段、两个地址。 */
export const splicePreview = (
  base: ChainVersion,
  coords: Pick<VideoEditMetadata, 'editStart' | 'editEnd'>,
  editedUrl: string,
): PlaySegment[] => {
  const segments: PlaySegment[] = []
  if (coords.editStart > 0)
    segments.push({ mediaUrl: base.mediaUrl, start: 0, end: coords.editStart, role: 'base' })
  segments.push({ mediaUrl: editedUrl, start: 0, role: 'edited' })
  segments.push({ mediaUrl: base.mediaUrl, start: coords.editEnd, role: 'base' })
  return segments
}

/** 版本与进行中的编辑。`jobs` 是链查询拿回来的（编辑记录与成片），根自己不在里面，单独传。 */
export const projectEditChain = (
  root: GenerationJob,
  jobs: readonly GenerationJob[],
): EditChain => {
  // 根没出片就没有可切的东西，链上别的记录也无处安放。
  if (root.outputUrl === null) return { versions: [], pending: [] }
  const groups = groupEdits(jobs)
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
  const composed = [...groups.values()]
    .flatMap((group) => {
      const master = group.master
      return master?.status === 'completed' && master.outputUrl !== null
        ? [{ group, master, mediaUrl: master.outputUrl }]
        : []
    })
    .sort((left, right) => left.master.createdAt.localeCompare(right.master.createdAt))
  for (const { group, master, mediaUrl } of composed) {
    const base = versions.find((version) => version.jobId === group.coords.baseJob)
    versions.push({
      key: group.coords.editId,
      jobId: master.id,
      label: `V${versions.length + 1}`,
      mediaUrl,
      createdAt: master.createdAt,
      edit: { ...group.coords, baseKey: base?.key ?? root.id },
    })
  }

  const pending: PendingEdit[] = []
  for (const group of groups.values()) {
    if (composed.some((item) => item.group === group)) continue
    const base = versions.find((version) => version.jobId === group.coords.baseJob)
    // 基底不在链里（别的根、或根本没出片）：这次编辑无处安放，不展示。
    if (base === undefined) continue
    const { stage, error } = stageOf(group)
    const editedUrl = group.video?.outputUrl ?? null
    pending.push({
      key: group.coords.editId,
      label: '',
      base,
      stage,
      coords: group.coords,
      prompt: promptOf(group.video),
      error,
      createdAt: (group.reference ?? group.video ?? group.master)?.createdAt ?? '',
      reference: group.reference,
      video: group.video,
      master: group.master,
      preview:
        editedUrl === null || (stage !== 'ready' && stage !== 'composing' && stage !== 'failed')
          ? undefined
          : splicePreview(base, group.coords, editedUrl),
    })
  }
  pending.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
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

/** 合成用的段列表：`end` 必须全部落实成数字。 */
export const composeSegments = (
  segments: readonly LaidOutSegment[],
): { url: string; start: number; end: number }[] =>
  segments.map((segment) => ({ url: segment.mediaUrl, start: segment.start, end: segment.end }))

/** 参考片段按关键帧切，多出来的在开头：结束点是准的，起点按实际时长往前推。 */
export const actualEditStart = (editEnd: number, clipDuration: number): number =>
  Math.max(0, Math.round((editEnd - clipDuration) * 1000) / 1000)

/** 每条根被成功编辑过几次，给抽屉那张卡显示。编辑结果不带 path/shot，只能靠 rootJob 认。 */
export const editCountsByRoot = (jobs: readonly GenerationJob[]): ReadonlyMap<string, number> => {
  const counts = new Map<string, number>()
  for (const job of jobs) {
    if (job.kind !== 'video' || job.status !== 'completed') continue
    const root = readVideoEditMetadata(job)?.rootJob
    if (root !== undefined) counts.set(root, (counts.get(root) ?? 0) + 1)
  }
  return counts
}
