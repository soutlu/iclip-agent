import type { GenerationJob } from '../storyboard.api'

type ConversationVideo = GenerationJob & { outputUrl: string }

export type ConversationVideoGroup = {
  id: string
  label: string
  /** 从旧到新排列，数组位置对应成功结果的版本号。 */
  videos: ConversationVideo[]
}

/** 没有来源的出片才是这段对话的出片；编辑段与合成挂在它下面，不单独成组。 */
const isOriginalVideo = (job: GenerationJob): job is ConversationVideo =>
  job.kind === 'video' &&
  job.operation === 'generate' &&
  job.sourceJobId == null &&
  job.status === 'completed' &&
  Boolean(job.outputUrl?.trim())

/** 按镜号归组；没有镜号的出片各自独立，不能据空镜号推成同一镜。 */
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
    const shot = video.shotIndex
    if (shot == null) {
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
