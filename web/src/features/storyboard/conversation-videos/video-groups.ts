import { readStoryboardMetadata } from '../generation-metadata'
import type { GenerationJob } from '../storyboard.api'

type ConversationVideo = GenerationJob & { outputUrl: string }

export type ConversationVideoGroup = {
  id: string
  label: string
  /** 从旧到新排列，数组位置对应成功结果的版本号。 */
  videos: ConversationVideo[]
}

/** 独立记录才是这段对话的出片；编辑链上的衍生记录挂在它的根下面，不单独成组。 */
const isOriginalVideo = (job: GenerationJob): job is ConversationVideo =>
  job.kind === 'video' &&
  job.status === 'completed' &&
  Boolean(job.outputUrl?.trim()) &&
  job.rootJobId === null

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
    const shot = readStoryboardMetadata(video)?.shot
    if (shot === undefined) {
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
