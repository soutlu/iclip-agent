/** 这一帧出现过的图，摊成编辑器缩略图条的条目。 */

import { isAppliedResult } from '../frame-status'
import { readStoryboardMetadata } from '../generation-metadata'
import { phaseOfStatus } from '../shots'
import type { GenerationJob } from '../storyboard.api'

/** 条目的 `key` 用来记住选中的是哪一条：任务产出的用任务号，跨「生成中→已生成」不变；
 * 只在别人的底图里出现过的图没有产出它的任务，用地址。 */
export type StripEntry =
  | { kind: 'current'; key: 'current'; url: string; job: GenerationJob | null }
  | { kind: 'image'; key: string; url: string; job: GenerationJob | null; createdAt: string }
  | { kind: 'pending'; key: string; job: GenerationJob }
  | { kind: 'failed'; key: string; job: GenerationJob }

export const CURRENT_KEY = 'current'

type Seed = { url: string; job: GenerationJob | null; createdAt: string }

/** 这一帧出现过的所有图：当前帧固定在头一个，其余按时间倒序。
 *
 * 图有两个来源：任务的产出，以及任务记下的底图——底图未必还在分镜里，它可能是上一轮没
 * 落盘的结果，也可能已被后来的编辑覆盖，只有这样才找得回来。同一张图两处都出现时留下
 * 产出它的那条任务；底图只说明这张图那时已经存在，说不出它从哪来。
 *
 * `jobs` 按这一格筛过即可，这里不再认坐标；顺序照服务端给的（新的在前），同一张图有几条
 * 任务都产出过时留最前那条。 */
export function frameImageEntries(
  jobs: readonly GenerationJob[],
  currentUrl: string,
): StripEntry[] {
  const running: StripEntry[] = []
  const seeds = new Map<string, Seed>()
  let currentJob: GenerationJob | null = null

  const remember = (url: string, job: GenerationJob | null, createdAt: string) => {
    const seen = seeds.get(url)
    if (seen === undefined) seeds.set(url, { url, job, createdAt })
    else if (seen.job === null && job !== null) seeds.set(url, { url, job, createdAt })
    // 两边都说不出这张图从哪来时，取更早那次：它至少那时就已经存在了。
    else if (seen.job === null && createdAt < seen.createdAt) seeds.set(url, { ...seen, createdAt })
  }

  for (const job of jobs) {
    const phase = phaseOfStatus(job.status)
    if (phase === 'queued' || phase === 'running')
      running.push({ kind: 'pending', key: job.id, job })
    else if (phase === 'failed') running.push({ kind: 'failed', key: job.id, job })
    else if (isAppliedResult(job, currentUrl)) currentJob ??= job
    else if (job.outputUrl !== null) remember(job.outputUrl, job, job.createdAt)

    const base = readStoryboardMetadata(job)?.sourceUrl
    if (base !== undefined && base !== currentUrl) remember(base, null, job.createdAt)
  }

  const images = [...seeds.values()].map((seed): StripEntry => ({
    kind: 'image',
    key: seed.job?.id ?? seed.url,
    url: seed.url,
    job: seed.job,
    createdAt: seed.createdAt,
  }))
  const rest = [...running, ...images].sort((left, right) =>
    entryTime(right).localeCompare(entryTime(left)),
  )
  return [{ kind: 'current', key: CURRENT_KEY, url: currentUrl, job: currentJob }, ...rest]
}

const entryTime = (entry: StripEntry): string =>
  entry.kind === 'current' ? '' : entry.kind === 'image' ? entry.createdAt : entry.job.createdAt

/** 这条条目上能画标注、也是下一次提交底图的那张图。
 *
 * 在跑和失败的任务没有产出，落回它当初的底图：右栏这才有草稿可显示、有东西可重新提交。 */
export const entryBaseUrl = (entry: StripEntry, currentUrl: string): string =>
  entry.kind === 'current' || entry.kind === 'image'
    ? entry.url
    : (readStoryboardMetadata(entry.job)?.sourceUrl ?? currentUrl)
