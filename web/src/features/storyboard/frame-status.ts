/** 分镜页帧上的图片任务状态：每格只看最新一条；在跑的一直显示，终态看过一次就清。 */

import { mediaStatusLabel, type MediaBadgeStatus } from '@/shared/ui/status-badge'
import { readStoryboardMetadata } from './generation-metadata'
import type { Shot } from './shot-document'
import { phaseOfStatus } from './shots'
import type { GenerationJob } from './storyboard.api'

export type FrameBadge =
  | { kind: 'queued' }
  | { kind: 'running' }
  | { kind: 'failed'; message: string | null }
  /** 点它直接打开编辑器看这条结果，所以要带上是哪条任务。 */
  | { kind: 'result'; jobId: string }

/** 角标的文字，胶片条的可访问名与主预览的提示共用一套词；只有「有新结果」是这里独有的说法。 */
export const frameBadgeText = (badge: FrameBadge): string =>
  badge.kind === 'result' ? '有新结果' : mediaStatusLabel(badge.kind)

/** 新结果就是跑完了的图片任务，画成已完成的样子，文字仍说「有新结果」。 */
export const frameBadgeStatus = (badge: FrameBadge): MediaBadgeStatus =>
  badge.kind === 'result' ? 'completed' : badge.kind

export const frameJobKey = (shotIndex: number, frameNumber: number) => `${shotIndex}:${frameNumber}`

/** 这条任务的结果已经是这一帧在用的那张。地址原样比，不做规范化：分镜里存的就是确认后的地址。 */
export const isAppliedResult = (job: GenerationJob, currentUrl: string): boolean =>
  job.outputUrl !== null && job.outputUrl === currentUrl

/** 每格最新一条图片任务：列表按服务端给的顺序（新的在前），每格取第一条。视频任务、坐标里没帧号的都落不到格上，跳过。 */
export const latestFrameJobs = (
  jobs: readonly GenerationJob[],
): ReadonlyMap<string, GenerationJob> => {
  const latest = new Map<string, GenerationJob>()
  for (const job of jobs) {
    const at = readStoryboardMetadata(job)
    if (job.kind !== 'image' || at === undefined || at.frame === undefined) continue
    const key = frameJobKey(at.shot, at.frame)
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
    } else if (job.outputUrl !== null && !isAppliedResult(job, url)) {
      badges.set(frameNumber, { kind: 'result', jobId: job.id })
    }
  })
  return badges
}
