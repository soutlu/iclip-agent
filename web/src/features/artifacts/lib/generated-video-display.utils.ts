import type { GeneratedVideoItem } from '@/features/artifacts/types/generated-video.types'

interface IndexedGeneratedVideoItem {
  index: number
  video: GeneratedVideoItem
}

/**
 * 判断生成视频是否已包含可播放输出地址。
 *
 * @param video - 后端归一化后的单条视频生成结果。
 * @returns 输出地址为非空字符串时返回 true。
 */
const hasGeneratedVideoOutputUrl = (video: GeneratedVideoItem) =>
  typeof video.outputUrl === 'string' && video.outputUrl.trim().length > 0

/**
 * 读取视频生成创建时间的排序值。
 *
 * @param video - 后端归一化后的单条视频生成结果。
 * @returns 有效 createdAt 返回毫秒时间戳，否则返回 null。
 */
const generatedVideoCreatedAtSortValue = (video: GeneratedVideoItem) => {
  if (!video.createdAt) {
    return null
  }

  const parsed = Date.parse(video.createdAt)

  return Number.isFinite(parsed) ? parsed : null
}

/**
 * 按视频生成事实时间排序。createdAt 优先，其次 attempt，最后保留输入顺序。
 *
 * @param first - 第一条带原始顺序的视频生成状态。
 * @param second - 第二条带原始顺序的视频生成状态。
 * @returns 小于 0 表示 first 更早。
 */
const compareGeneratedVideoChronology = (
  first: IndexedGeneratedVideoItem,
  second: IndexedGeneratedVideoItem,
) => {
  const firstCreatedAt = generatedVideoCreatedAtSortValue(first.video)
  const secondCreatedAt = generatedVideoCreatedAtSortValue(second.video)

  if (firstCreatedAt !== null && secondCreatedAt !== null && firstCreatedAt !== secondCreatedAt) {
    return firstCreatedAt - secondCreatedAt
  }

  const firstAttempt = first.video.attempt ?? 0
  const secondAttempt = second.video.attempt ?? 0

  if (firstAttempt !== secondAttempt) {
    return firstAttempt - secondAttempt
  }

  return first.index - second.index
}

const generatedVideosByPromptIndex = (videos: GeneratedVideoItem[]) => {
  const videosByPromptIndex = new Map<number, IndexedGeneratedVideoItem[]>()
  const promptlessVideos: IndexedGeneratedVideoItem[] = []

  videos.forEach((video, index) => {
    const indexedVideo = { index, video }

    if (typeof video.promptIndex !== 'number') {
      promptlessVideos.push(indexedVideo)
      return
    }

    const currentVideos = videosByPromptIndex.get(video.promptIndex) ?? []

    currentVideos.push(indexedVideo)
    videosByPromptIndex.set(video.promptIndex, currentVideos)
  })

  return { promptlessVideos, videosByPromptIndex }
}

/**
 * 过滤同镜头更高 attempt 成功后残留的旧状态占位卡。
 *
 * @param videos - 从 generated-video artifacts 聚合出的原始视频生成结果。
 * @returns 对用户仍有意义的当前视频生成结果。
 */
export const filterVisibleGeneratedVideos = (videos: GeneratedVideoItem[]) => {
  const { promptlessVideos, videosByPromptIndex } = generatedVideosByPromptIndex(videos)
  const visibleVideos: IndexedGeneratedVideoItem[] = [...promptlessVideos]

  for (const promptVideos of videosByPromptIndex.values()) {
    const orderedVideos = [...promptVideos].sort(compareGeneratedVideoChronology)
    const latestVideo = orderedVideos.at(-1)

    if (!latestVideo) {
      continue
    }

    for (const video of orderedVideos) {
      if (hasGeneratedVideoOutputUrl(video.video) || video === latestVideo) {
        visibleVideos.push(video)
      }
    }
  }

  return visibleVideos.sort((first, second) => first.index - second.index).map(({ video }) => video)
}

/**
 * 按镜头序号读取当前最新视频生成状态。
 *
 * @param videos - 从 generated-video artifacts 聚合出的原始视频生成结果。
 * @returns 以 promptIndex 为 key 的当前状态映射。
 */
export const getCurrentGeneratedVideoStatusByPromptIndex = (videos: GeneratedVideoItem[]) => {
  const { videosByPromptIndex } = generatedVideosByPromptIndex(videos)
  const statusByPromptIndex = new Map<number, GeneratedVideoItem['status']>()

  for (const [promptIndex, promptVideos] of videosByPromptIndex) {
    const latestVideo = [...promptVideos].sort(compareGeneratedVideoChronology).at(-1)

    if (latestVideo) {
      statusByPromptIndex.set(promptIndex, latestVideo.video.status)
    }
  }

  return statusByPromptIndex
}
