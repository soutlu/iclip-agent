import { readVideoEditMetadata } from '../generation-metadata'
import type { GenerationJob } from '../storyboard.api'

type ConversationVideo = GenerationJob & { outputUrl: string }

export type ConversationVideoGroup = {
  id: string
  label: string
  /** 从旧到新排列，数组位置对应成功结果的版本号。 */
  videos: ConversationVideo[]
}

const isOriginalVideo = (job: GenerationJob): job is ConversationVideo =>
  job.kind === 'video' &&
  job.status === 'completed' &&
  Boolean(job.outputUrl?.trim()) &&
  readVideoEditMetadata(job) === undefined

/** 只用正整数镜号归组；没有合法镜号的原始视频各自独立，不能据空坐标推成同一镜。 */
export const groupConversationVideos = (
  jobs: readonly GenerationJob[],
): ConversationVideoGroup[] => {
  const videos = jobs
    .filter(isOriginalVideo)
    .sort(
      (left, right) =>
        Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.id.localeCompare(right.id),
    )
  const shots = new Map<number, ConversationVideoGroup>()
  const standalone: ConversationVideoGroup[] = []

  for (const video of videos) {
    const shot = video.metadata?.['shot']
    if (typeof shot !== 'number' || !Number.isSafeInteger(shot) || shot <= 0) {
      standalone.push({
        id: `video-${video.id}`,
        label: `视频 ${standalone.length + 1}`,
        videos: [video],
      })
      continue
    }
    const group = shots.get(shot)
    if (group === undefined) {
      shots.set(shot, { id: `shot-${shot}`, label: `镜头组 ${shot}`, videos: [video] })
    } else {
      group.videos.push(video)
    }
  }

  return [
    ...[...shots].sort(([left], [right]) => left - right).map(([, group]) => group),
    ...standalone,
  ]
}
