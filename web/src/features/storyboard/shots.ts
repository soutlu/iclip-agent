/** 分镜的文本展示、图片选择与历史生成状态辅助函数。 */

import type { WorkbenchRef } from '@/shared/workbench'

export const SHOTS_PATH = 'video_shot.json'

export const aspectRatioStyle = (aspectRatio: string) => aspectRatio.replace(':', ' / ')

const FRAME_REF = /@Image(\d+)/g

/** 以原文起始位置作为 key，避免重复正文产生冲突。 */
export type PromptSegment =
  { id: string; kind: 'text'; text: string } | { id: string; kind: 'frame'; number: number }

export const splitPrompt = (prompt: string): PromptSegment[] => {
  const segments: PromptSegment[] = []
  let cursor = 0
  for (const match of prompt.matchAll(FRAME_REF)) {
    const at = match.index
    if (at > cursor) {
      segments.push({ id: `t${cursor}`, kind: 'text', text: prompt.slice(cursor, at) })
    }
    segments.push({ id: `f${at}`, kind: 'frame', number: Number(match[1]) })
    cursor = at + match[0].length
  }
  if (cursor < prompt.length) {
    segments.push({ id: `t${cursor}`, kind: 'text', text: prompt.slice(cursor) })
  }
  return segments
}

export interface ShotScene {
  /** 由结构化时间线的位置生成的稳定显示标识。 */
  id: string
  scene: number
  startSeconds: number
  endSeconds: number
  segments: PromptSegment[]
  /** 按出现顺序返回去重后的帧编号。 */
  frameNumbers: number[]
}

export interface ShotTimeline {
  preamble: string
  scenes: ShotScene[]
}

export const sceneOfFrame = (timeline: ShotTimeline, frameNumber: number): ShotScene | undefined =>
  timeline.scenes.find((scene) => scene.frameNumbers.includes(frameNumber))

export const firstFrameOfScene = (scene: ShotScene): number | undefined => scene.frameNumbers[0]

export const shotSelectionRef = (index: number, frame?: number): WorkbenchRef =>
  frame === undefined
    ? { id: `shot:${index}`, label: `镜头组 ${index}`, prefix: `针对镜头组 ${index}：` }
    : {
        id: `shot:${index}:frame:${frame}`,
        label: `镜头组 ${index} · 帧 @${frame}`,
        prefix: `针对镜头组 ${index} 的帧 @${frame}：`,
      }

export interface ShotGeneration {
  createdAt: string
  kind: string
  outputUrl: string | null
  shotIndex: number | null
  status: string
}

const IN_FLIGHT = new Set(['pending', 'submitting', 'submitted'])

export const isRunningStatus = (status: string): boolean => IN_FLIGHT.has(status)

export const latestShotVideos = (jobs: readonly ShotGeneration[]): Map<number, string> => {
  const latest = new Map<number, { at: string; url: string }>()
  for (const job of jobs) {
    if (job.kind !== 'video' || job.status !== 'completed') continue
    if (job.shotIndex === null || job.outputUrl === null) continue
    const current = latest.get(job.shotIndex)
    if (current === undefined || current.at < job.createdAt) {
      latest.set(job.shotIndex, { at: job.createdAt, url: job.outputUrl })
    }
  }
  return new Map([...latest].map(([index, take]) => [index, take.url]))
}

export const runningShots = (jobs: readonly ShotGeneration[]): Set<number> =>
  new Set(
    jobs.flatMap((job) =>
      job.kind === 'video' && job.shotIndex !== null && isRunningStatus(job.status)
        ? [job.shotIndex]
        : [],
    ),
  )

export type ShotStatus = 'ready' | 'running' | 'idle'

/** 已有成片优先于生成中状态，便于识别可观看内容。 */
export const shotStatus = (
  index: number,
  videos: ReadonlyMap<number, string>,
  running: ReadonlySet<number>,
): ShotStatus => {
  if (videos.has(index)) return 'ready'
  return running.has(index) ? 'running' : 'idle'
}
