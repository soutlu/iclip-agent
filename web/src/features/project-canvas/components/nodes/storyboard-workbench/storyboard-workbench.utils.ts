import {
  ASPECT_RATIO_PART_COUNT,
  DEFAULT_STORYBOARD_PREVIEW_ASPECT_RATIO,
  DEFAULT_STORYBOARD_PREVIEW_ASPECT_RATIO_LABEL,
  EMPTY_SHOT_ID,
  STORYBOARD_NODE_WIDTH,
  STORYBOARD_PLAYER_FRAME_STEP_SECONDS,
  STORYBOARD_SCREEN_MODE_NODE_WIDTH,
  STORYBOARD_SCREEN_MODE_PREVIEW_METRICS,
  STORYBOARD_SCRIPT_MODE_PREVIEW_METRICS,
  STORYBOARD_TIMELINE_EDGE_GUTTER,
  STORYBOARD_TIMELINE_SEGMENT_GAP,
} from './storyboard-workbench.constants'
import type {
  StoryboardWorkbenchMediaItem,
  StoryboardWorkbenchPreviewFrameSize,
  StoryboardWorkbenchRedoShotInput,
  StoryboardWorkbenchShot,
  StoryboardWorkbenchShotTimeSegment,
  StoryboardWorkbenchTimelineSegment,
} from './storyboard-workbench.types'

export const getStoryboardNodeWidth = (isScreenMode: boolean) =>
  isScreenMode ? STORYBOARD_SCREEN_MODE_NODE_WIDTH : STORYBOARD_NODE_WIDTH

/**
 * 读取当前视图模式下的右侧预览区布局度量。
 *
 * @param isScreenMode - 是否为参考节点的 simpleViewerMode。
 * @returns 预览区宽度、预览画面尺寸和时间轴视口宽度。
 */
export const getStoryboardPreviewPanelMetrics = (isScreenMode: boolean) =>
  isScreenMode ? STORYBOARD_SCREEN_MODE_PREVIEW_METRICS : STORYBOARD_SCRIPT_MODE_PREVIEW_METRICS

/**
 * 解析故事板预览区使用的视频比例。
 *
 * @param aspectRatio - 形如 16:9、9:16 或 1:1 的比例字符串；缺省时使用项目视频默认比例。
 * @returns 可传给 Radix AspectRatio 的数值比例。
 * @throws 当传入的比例字符串不是两个正数片段时抛错。
 */
export const parseStoryboardPreviewAspectRatio = (aspectRatio?: string) => {
  if (!aspectRatio) {
    return DEFAULT_STORYBOARD_PREVIEW_ASPECT_RATIO
  }

  const parts = aspectRatio.split(':')

  if (parts.length !== ASPECT_RATIO_PART_COUNT) {
    throw new Error(
      `Storyboard preview aspect ratio must be formatted as width:height; received ${aspectRatio}.`,
    )
  }

  const [widthPart, heightPart] = parts
  const width = Number(widthPart)
  const height = Number(heightPart)

  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error(
      `Storyboard preview aspect ratio must contain positive numbers; received ${aspectRatio}.`,
    )
  }

  return width / height
}

/**
 * 读取当前预览媒体应该使用的视频比例。
 *
 * @param preview - 当前时间所在镜头的预览媒体。
 * @param nodeAspectRatio - 故事板节点级视频比例。
 * @returns 当前预览媒体优先、节点比例其次、项目默认比例兜底的数值比例。
 */
export const getStoryboardPreviewAspectRatio = (
  preview: StoryboardWorkbenchMediaItem | null,
  nodeAspectRatio?: string,
) =>
  parseStoryboardPreviewAspectRatio(
    preview?.aspectRatio ?? nodeAspectRatio ?? DEFAULT_STORYBOARD_PREVIEW_ASPECT_RATIO_LABEL,
  )

/**
 * 在给定可用区域内计算指定比例能显示的最大画面框。
 *
 * @param params - 画面框计算参数。
 * @param params.aspectRatio - 当前视频宽高比。
 * @param params.maxHeight - 可用最大高度。
 * @param params.maxWidth - 可用最大宽度。
 * @returns 不超过可用区域且保持视频比例的画面框尺寸。
 */
export const getStoryboardPreviewFrameSize = ({
  aspectRatio,
  maxHeight,
  maxWidth,
}: {
  aspectRatio: number
  maxHeight: number
  maxWidth: number
}): StoryboardWorkbenchPreviewFrameSize => {
  if (!Number.isFinite(aspectRatio) || aspectRatio <= 0) {
    throw new Error(
      `Storyboard preview aspect ratio must be finite and positive; received ${String(aspectRatio)}.`,
    )
  }

  if (
    !Number.isFinite(maxHeight) ||
    !Number.isFinite(maxWidth) ||
    maxHeight <= 0 ||
    maxWidth <= 0
  ) {
    throw new Error(
      `Storyboard preview bounds must be finite and positive; received ${String(maxWidth)}x${String(maxHeight)}.`,
    )
  }

  const boundsAspectRatio = maxWidth / maxHeight

  if (aspectRatio >= boundsAspectRatio) {
    return {
      height: Math.round(maxWidth / aspectRatio),
      width: maxWidth,
    }
  }

  return {
    height: maxHeight,
    width: Math.round(maxHeight * aspectRatio),
  }
}

/**
 * 将数值限制在给定范围内。
 *
 * @param value - 原始数值。
 * @param min - 允许的最小值。
 * @param max - 允许的最大值。
 * @returns 夹在区间内的数值。
 */
export const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value))

/**
 * 格式化两位时间段。
 *
 * @param value - 原始时间段。
 * @returns 两位数字字符串。
 */
export const formatTimeSegment = (value: number) =>
  Math.max(0, Math.floor(value)).toString().padStart(2, '0')

/**
 * 格式化镜头工具栏时长。
 *
 * @param seconds - 原始秒数。
 * @returns mm:ss 文案。
 */
export const formatShotDuration = (seconds: number) => {
  const safeSeconds = Math.max(0, Math.round(seconds))
  const minutes = Math.floor(safeSeconds / 60)
  const remainingSeconds = safeSeconds % 60

  return `${formatTimeSegment(minutes)}:${formatTimeSegment(remainingSeconds)}`
}

/**
 * 格式化素材封面时长。
 *
 * @param seconds - 原始秒数。
 * @returns m:ss 文案。
 */
export const formatCoverDuration = (seconds: number) => {
  const safeSeconds = Math.max(0, Math.round(seconds))
  const minutes = Math.floor(safeSeconds / 60)
  const remainingSeconds = safeSeconds % 60

  return `${minutes.toString()}:${formatTimeSegment(remainingSeconds)}`
}

/**
 * 格式化播放器时间。
 *
 * @param seconds - 原始秒数。
 * @returns hh:mm:ss 文案。
 */
export const formatPlayerTime = (seconds: number) => {
  const safeSeconds = Math.max(0, Math.round(seconds))
  const hours = Math.floor(safeSeconds / 3600)
  const minutes = Math.floor((safeSeconds % 3600) / 60)
  const remainingSeconds = safeSeconds % 60

  return `${formatTimeSegment(hours)}:${formatTimeSegment(minutes)}:${formatTimeSegment(remainingSeconds)}`
}

/**
 * 读取明确声明的正数秒值。
 *
 * @param seconds - 外部传入的秒值。
 * @returns 合法正数秒值；缺失或非法时返回 null。
 */
export const readPositiveDurationSeconds = (seconds?: number) =>
  typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 ? seconds : null

/**
 * 读取镜头有效时长。
 *
 * @param shot - 当前镜头。
 * @returns 镜头秒数；没有明确时长时返回 0。
 */
export const getShotDurationSeconds = (shot: StoryboardWorkbenchShot) => {
  const shotDurationSeconds = readPositiveDurationSeconds(shot.durationSeconds)

  if (shotDurationSeconds !== null) {
    return shotDurationSeconds
  }

  return readPositiveDurationSeconds(shot.media[0]?.durationSeconds) ?? 0
}

/**
 * 判断镜头是否应进入右侧预览时间轴。
 *
 * @param shot - 当前镜头。
 * @returns 有明确正时长且未显式排除时返回 true。
 */
export const isPreviewTimelineShot = (shot: StoryboardWorkbenchShot) =>
  shot.includeInPreviewTimeline !== false && getShotDurationSeconds(shot) > 0

/**
 * 判断镜头是否只是空故事板占位。
 *
 * @param shot - 待检查的镜头。
 * @returns 是否为工作台本地创建的空占位镜头。
 */
export const isStoryboardEmptyShot = (shot: StoryboardWorkbenchShot) => shot.id === EMPTY_SHOT_ID

/**
 * 读取用于重做镜头的提示词。
 *
 * @param shot - 当前镜头。
 * @returns 镜头提示词；没有独立 prompt 时使用镜头标题。
 */
export const getStoryboardRedoPrompt = (shot: StoryboardWorkbenchShot) => {
  const prompt = shot.prompt?.trim()

  if (prompt) {
    return prompt
  }

  const title = shot.title.trim()

  return title.length > 0 ? title : shot.id
}

/**
 * 创建重做镜头事件负载。
 *
 * @param params - 事件负载参数。
 * @param params.nodeAspectRatio - 节点级视频比例。
 * @param params.shot - 当前镜头。
 * @returns 传递给 Direct Canvas 输入框的结构化草稿数据。
 */
export const createStoryboardRedoShotInput = ({
  nodeAspectRatio,
  shot,
}: {
  nodeAspectRatio?: string
  shot: StoryboardWorkbenchShot
}): StoryboardWorkbenchRedoShotInput => {
  const redoMedia = shot.referenceMedia ?? shot.media
  const primaryMedia = redoMedia[0]

  return {
    aspectRatio: primaryMedia?.aspectRatio ?? nodeAspectRatio,
    media: redoMedia,
    prompt: getStoryboardRedoPrompt(shot),
    seconds: getShotDurationSeconds(shot),
    shotId: shot.id,
    shotIndex: shot.shotIndex,
    title: shot.title,
  }
}

/**
 * 下载故事板镜头素材。
 *
 * @param media - 当前素材。
 * @returns 无返回值；浏览器会开始下载素材。
 * @throws 当素材缺少 URL 时抛错，避免下载按钮静默失败。
 */
export const downloadStoryboardShotMedia = async (media: StoryboardWorkbenchMediaItem) => {
  const url = media.url.trim()

  if (url.length === 0) {
    throw new Error(`Storyboard media ${media.id} is missing a downloadable URL.`)
  }

  const response = await fetch(url)

  if (!response.ok) {
    throw new Error(`Storyboard media ${media.id} download failed with HTTP ${response.status}.`)
  }

  const blob = await response.blob()
  const objectUrl = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.download = media.fileName
  anchor.href = objectUrl
  anchor.rel = 'noopener'
  anchor.style.display = 'none'
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
}

export const getStoryboardDownloadableMedia = (shots: StoryboardWorkbenchShot[]) =>
  shots.flatMap((shot) => shot.media.filter((media) => media.url.trim().length > 0))

export const exportAllStoryboardShotMedia = async (shots: StoryboardWorkbenchShot[]) => {
  const mediaItems = getStoryboardDownloadableMedia(shots)

  if (mediaItems.length === 0) {
    return
  }

  await Promise.allSettled(mediaItems.map((media) => downloadStoryboardShotMedia(media)))
}

/**
 * 计算故事板总时长。
 *
 * @param shots - 镜头列表。
 * @returns 总秒数。
 */
export const getTotalDurationSeconds = (shots: StoryboardWorkbenchShot[]) =>
  shots.reduce((total, shot) => total + getShotDurationSeconds(shot), 0)

/**
 * 计算时间轴中真正用于 shot 片段的像素宽度。
 *
 * @param shotCount - 镜头数量。
 * @param timelineViewportWidth - 时间轴横向视口宽度。
 * @returns 扣除片段间距后的总片段宽度。
 */
export const getTimelineSegmentAreaWidthPx = (shotCount: number, timelineViewportWidth: number) =>
  Math.max(
    0,
    timelineViewportWidth -
      STORYBOARD_TIMELINE_EDGE_GUTTER * 2 -
      Math.max(0, shotCount - 1) * STORYBOARD_TIMELINE_SEGMENT_GAP,
  )

/**
 * 构造按时间顺序排列的镜头基础时间段。
 *
 * @param shots - 要渲染的镜头列表。
 * @returns 带开始时间的时间段列表。
 */
export const getShotTimeSegments = (
  shots: StoryboardWorkbenchShot[],
): StoryboardWorkbenchShotTimeSegment[] => {
  let startSeconds = 0

  return shots.map((shot, shotIndex) => {
    const durationSeconds = getShotDurationSeconds(shot)
    const segment: StoryboardWorkbenchShotTimeSegment = {
      durationSeconds,
      media: shot.media[0] ?? null,
      shot,
      shotIndex,
      startSeconds,
    }

    startSeconds += durationSeconds

    return segment
  })
}

/**
 * 构造按时间顺序排列的镜头时间轴片段。
 *
 * @param shots - 要渲染的镜头列表。
 * @param timelineViewportWidth - 时间轴横向视口宽度。
 * @returns 带开始时间和像素宽度的时间轴片段列表。
 */
export const getTimelineSegments = (
  shots: StoryboardWorkbenchShot[],
  timelineViewportWidth: number,
): StoryboardWorkbenchTimelineSegment[] => {
  let usedWidthPx = 0
  const timeSegments = getShotTimeSegments(shots)
  const timelineDurationSeconds = timeSegments.reduce(
    (total, segment) => total + segment.durationSeconds,
    0,
  )
  const segmentAreaWidthPx = getTimelineSegmentAreaWidthPx(shots.length, timelineViewportWidth)
  const fallbackSegmentWidthPx =
    shots.length > 0 ? Math.floor(segmentAreaWidthPx / shots.length) : 0

  return timeSegments.map((segment, segmentIndex) => {
    const isLastShot = segmentIndex === timeSegments.length - 1
    let widthPx = segmentAreaWidthPx - usedWidthPx

    if (!isLastShot) {
      widthPx =
        timelineDurationSeconds > 0
          ? Math.round((segment.durationSeconds / timelineDurationSeconds) * segmentAreaWidthPx)
          : fallbackSegmentWidthPx
    }

    usedWidthPx += widthPx

    return {
      ...segment,
      widthPx,
    }
  })
}

/**
 * 计算播放器 slider 的可用最大值。
 *
 * @param totalDurationSeconds - 业务总时长秒数。
 * @returns Radix Slider 可接受的最大秒数；无时长时保留一个最小正区间供禁用态渲染。
 */
export const getSliderMaxSeconds = (totalDurationSeconds: number) =>
  totalDurationSeconds > 0 ? totalDurationSeconds : STORYBOARD_PLAYER_FRAME_STEP_SECONDS

/**
 * 读取 Radix Slider 单值数组里的秒数。
 *
 * @param value - Slider 返回的受控值数组。
 * @returns 当前预览秒数。
 * @throws 当 Slider 返回非法值时抛错，避免静默吞掉错误状态。
 */
export const readSliderTimeSeconds = (value: number[]) => {
  const nextTimeSeconds = value[0]

  if (typeof nextTimeSeconds !== 'number' || !Number.isFinite(nextTimeSeconds)) {
    throw new Error('Storyboard preview slider emitted an invalid time value.')
  }

  return nextTimeSeconds
}

/**
 * 计算播放指针在时间轴上的横向百分比。
 *
 * @param currentTimeSeconds - 当前预览秒数。
 * @param totalDurationSeconds - 总时长秒数。
 * @returns 0 到 100 的位置百分比。
 */
export const getTimelinePlayheadLeftPercent = (
  currentTimeSeconds: number,
  totalDurationSeconds: number,
) => {
  if (totalDurationSeconds <= 0) {
    return 0
  }

  return (clamp(currentTimeSeconds, 0, totalDurationSeconds) / totalDurationSeconds) * 100
}

/**
 * 按当前时间定位所在的镜头时间段。
 *
 * @param shots - 镜头列表。
 * @param currentTimeSeconds - 当前预览秒数。
 * @returns 当前时间对应的镜头时间段；没有镜头时返回 null。
 */
export const getTimelineSegmentAtTime = (
  shots: StoryboardWorkbenchShot[],
  currentTimeSeconds: number,
): StoryboardWorkbenchShotTimeSegment | null => {
  const segments = getShotTimeSegments(shots)

  if (segments.length === 0) {
    return null
  }

  const timelineDurationSeconds = segments.reduce(
    (total, segment) => total + segment.durationSeconds,
    0,
  )
  const safeCurrentTimeSeconds = clamp(currentTimeSeconds, 0, timelineDurationSeconds)
  const matchingSegment = segments.find(
    (segment) => safeCurrentTimeSeconds < segment.startSeconds + segment.durationSeconds,
  )

  return matchingSegment ?? segments.at(-1) ?? null
}

/**
 * 读取预览媒体。
 *
 * @param shots - 镜头列表。
 * @param activeShotId - 当前激活镜头 id。
 * @param preview - 外部指定预览媒体。
 * @returns 预览媒体；没有时返回 null。
 */
export const getPreviewMedia = (
  shots: StoryboardWorkbenchShot[],
  activeShotId?: string,
  preview?: StoryboardWorkbenchMediaItem,
) => {
  if (preview) {
    return preview
  }

  const activeShot = activeShotId ? shots.find((shot) => shot.id === activeShotId) : null
  const shotWithMedia = activeShot?.media[0]
    ? activeShot
    : shots.find((shot) => shot.media.length > 0)

  return shotWithMedia?.media[0] ?? null
}

/**
 * 按当前预览时间读取镜头 id。
 *
 * @param shots - 镜头列表。
 * @param currentTimeSeconds - 当前预览秒数。
 * @returns 当前时间所在镜头 id；没有镜头时返回 undefined。
 */
export const getShotIdAtTime = (shots: StoryboardWorkbenchShot[], currentTimeSeconds: number) =>
  getTimelineSegmentAtTime(shots, currentTimeSeconds)?.shot.id

/**
 * 创建空状态镜头。
 *
 * @returns 与参考节点空镜头一致的占位镜头。
 */
export const createEmptyShot = (): StoryboardWorkbenchShot => ({
  id: EMPTY_SHOT_ID,
  media: [],
  shotIndex: 0,
  status: 'draft',
  title: 'Shot',
})

/**
 * 读取需要实际渲染的镜头列表。
 *
 * @param shots - 外部传入镜头列表。
 * @returns 非空镜头列表；空数据时补一条占位。
 */
export const getRenderableShots = (shots: StoryboardWorkbenchShot[]) =>
  shots.length > 0 ? shots : [createEmptyShot()]

/**
 * 读取右侧预览时间轴要消费的镜头。
 *
 * @param shots - 外部传入镜头列表。
 * @returns 有明确时长且允许进入时间轴的镜头列表。
 */
export const getPreviewTimelineShots = (shots: StoryboardWorkbenchShot[]) =>
  shots.filter(isPreviewTimelineShot)

/**
 * 生成参考节点中的 free-drop payload。
 *
 * @param payload - payload 字段。
 * @returns 序列化后的 payload 字符串。
 */
export const stringifyDropPayload = (payload: Record<string, string>) => JSON.stringify(payload)
