/** 分镜页帧上的图片任务状态：每格只看最新一条；在跑的一直显示，终态看过一次就清。 */

import type { Shot } from './shot-document'
import { phaseOfStatus } from './shots'
import type { GenerationJob } from './storyboard.api'

export type FrameBadge =
  | { kind: 'queued' }
  | { kind: 'running' }
  | { kind: 'failed'; message: string | null }
  | { kind: 'result' }

const TEXT: Record<FrameBadge['kind'], string> = {
  failed: '生成失败',
  queued: '排队中',
  result: '有新结果',
  running: '生成中',
}

/** 角标的文字，胶片条的可访问名与主预览的提示共用一套词。 */
export const frameBadgeText = (badge: FrameBadge): string => TEXT[badge.kind]

export const frameJobKey = (shotIndex: number, frameNumber: number) => `${shotIndex}:${frameNumber}`

const newestFirst = (left: GenerationJob, right: GenerationJob) =>
  right.createdAt.localeCompare(left.createdAt)

/** 每格最新一条图片任务。视频任务和没标镜头组、帧号的记录落不到格上，跳过。 */
export const latestFrameJobs = (
  jobs: readonly GenerationJob[],
): ReadonlyMap<string, GenerationJob> => {
  const latest = new Map<string, GenerationJob>()
  for (const job of [...jobs].sort(newestFirst)) {
    const frameNumber = job.request['frameNumber']
    if (job.kind !== 'image' || job.shotIndex === null || typeof frameNumber !== 'number') continue
    const key = frameJobKey(job.shotIndex, frameNumber)
    if (!latest.has(key)) latest.set(key, job)
  }
  return latest
}

/** 这一组每帧要挂的角标。结果已经是当前帧的不算新结果；失败与未采用的结果在 `seen` 里就不再显示。 */
export const frameBadges = (
  shot: Shot,
  latest: ReadonlyMap<string, GenerationJob>,
  seen: ReadonlySet<string>,
): ReadonlyMap<number, FrameBadge> => {
  const badges = new Map<number, FrameBadge>()
  shot.image_urls.forEach((url, position) => {
    const frameNumber = position + 1
    const job = latest.get(frameJobKey(shot.index, frameNumber))
    if (job === undefined) return
    const phase = phaseOfStatus(job.status)
    if (phase === 'queued' || phase === 'running') badges.set(frameNumber, { kind: phase })
    else if (seen.has(job.id)) return
    else if (phase === 'failed') {
      badges.set(frameNumber, { kind: 'failed', message: job.errorMessage })
    } else if (job.outputUrl !== null && job.outputUrl !== url) {
      badges.set(frameNumber, { kind: 'result' })
    }
  })
  return badges
}
