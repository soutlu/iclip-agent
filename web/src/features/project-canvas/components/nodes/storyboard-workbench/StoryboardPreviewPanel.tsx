import { AspectRatio as AspectRatioPrimitive, Slider as SliderPrimitive } from 'radix-ui'
import { type MouseEvent, useEffect, useState } from 'react'
import { cn } from '@/shared/lib/utils'
import {
  StoryboardAddScreenIcon,
  StoryboardMoreIcon,
  StoryboardPlayIcon,
  StoryboardPreviewToolIcon,
} from './storyboard-workbench-icons'
import {
  PREVIEW_EXPORT_ACTION_ITEMS,
  PREVIEW_TOOL_ITEMS,
  STORYBOARD_PLAYER_CONTROLS_HEIGHT,
  STORYBOARD_PLAYER_FRAME_STEP_SECONDS,
  STORYBOARD_PLAYER_PLAY_BUTTON_SIZE,
  STORYBOARD_PLAYER_PLAY_ICON_SIZE,
  STORYBOARD_PLAYER_TIME_DIVIDER_HEIGHT,
  STORYBOARD_PLAYER_TIME_DIVIDER_MARGIN_X,
  STORYBOARD_PLAYER_TIME_FONT_SIZE,
  STORYBOARD_PLAYER_TIME_GAP,
  STORYBOARD_TIMELINE_EDGE_GUTTER,
  STORYBOARD_TIMELINE_HEIGHT,
  STORYBOARD_TIMELINE_PLAYHEAD_KNOB_SIZE,
  STORYBOARD_TIMELINE_PLAYHEAD_TOP_OFFSET,
  STORYBOARD_TIMELINE_SEGMENT_GAP,
  STORYBOARD_TIMELINE_SEGMENT_HEIGHT,
  STORYBOARD_TIMELINE_TOP_GUTTER,
} from './storyboard-workbench.constants'
import type {
  StoryboardPreviewToolbarProps,
  StoryboardWorkbenchExportAction,
  StoryboardWorkbenchPlayerControlsProps,
  StoryboardWorkbenchPreviewPanelProps,
  StoryboardWorkbenchPreviewSurfaceProps,
  StoryboardWorkbenchTimelineProps,
  StoryboardWorkbenchTimelineSegment,
} from './storyboard-workbench.types'
import {
  clamp,
  exportAllStoryboardShotMedia,
  formatCoverDuration,
  formatPlayerTime,
  getSliderMaxSeconds,
  getStoryboardDownloadableMedia,
  getStoryboardPreviewFrameSize,
  getStoryboardPreviewPanelMetrics,
  getTimelinePlayheadLeftPercent,
  getTimelineSegments,
  readSliderTimeSeconds,
} from './storyboard-workbench.utils'

/**
 * 渲染预览区顶部配置条。
 *
 * @returns 参考节点的 globalConfigGroup。
 */
function StoryboardPreviewToolbar({ shots }: StoryboardPreviewToolbarProps) {
  const [isExportMenuOpen, setIsExportMenuOpen] = useState(false)
  const [selectedExportAction, setSelectedExportAction] =
    useState<StoryboardWorkbenchExportAction | null>(null)
  const hasDownloadableMedia = getStoryboardDownloadableMedia(shots).length > 0

  const handleExportButtonClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
    setIsExportMenuOpen((isOpen) => !isOpen)
  }

  const handleExportActionSelect = (exportAction: StoryboardWorkbenchExportAction) => {
    if (exportAction !== 'all') {
      return
    }

    setSelectedExportAction(exportAction)
    setIsExportMenuOpen(false)
    void exportAllStoryboardShotMedia(shots).catch(() => undefined)
  }

  return (
    <div
      className="globalConfigGroup-iVNaGs relative flex h-[117px] shrink-0 items-center justify-center border-b-[3px] border-[var(--storyboard-node-border)] bg-[var(--storyboard-node-script-surface)] px-[43px] pt-[11px]"
      data-storyboard-workbench-export-action-selected={selectedExportAction ?? undefined}
    >
      {PREVIEW_TOOL_ITEMS.map((item, itemIndex) => (
        <div className="flex h-full items-center" key={item.id}>
          <div
            className="globalConfigItem-Om7sHY nodrag nopan flex h-[85px] translate-y-[11px] items-center rounded-xl border-[3px] border-transparent px-[32px] text-[var(--storyboard-node-preview-tool-text)]"
            data-storyboard-workbench-preview-tool={item.id}
            style={{
              backgroundColor: 'var(--storyboard-node-surface)',
              borderColor: 'var(--storyboard-node-surface)',
              color: 'var(--storyboard-node-preview-tool-text)',
            }}
          >
            <div>
              <div className="content-lkO5sj flex items-center gap-[21px] text-headline-lg leading-none font-medium">
                <StoryboardPreviewToolIcon id={item.id} size={43} />
                <div className="name-E4Kein">{item.label}</div>
              </div>
            </div>
            <div style={{ height: '100%' }} />
          </div>
          {itemIndex < PREVIEW_TOOL_ITEMS.length - 1 ? (
            <div className="globalConfigDivider-Nk7_i0 mx-[43px] h-[53px] w-[3px] bg-[var(--storyboard-node-border)]" />
          ) : null}
        </div>
      ))}
      <div
        className="absolute top-0 right-[64px] flex h-full items-center"
        data-storyboard-workbench-export-menu-anchor="true"
      >
        <button
          aria-expanded={isExportMenuOpen}
          aria-haspopup="menu"
          aria-label="打开导出菜单"
          className="nodrag nopan grid h-[85px] w-[85px] translate-y-[11px] place-items-center rounded-md bg-[var(--storyboard-node-tool-surface)] text-[var(--storyboard-node-preview-tool-text)] hover:bg-[var(--storyboard-node-selected-surface)]"
          data-storyboard-workbench-export-menu-button="true"
          onClick={handleExportButtonClick}
          onPointerDown={(event) => event.stopPropagation()}
          type="button"
        >
          <StoryboardMoreIcon size={43} />
        </button>
        {isExportMenuOpen ? (
          <div
            className="nodrag nopan absolute top-[83px] right-0 w-[240px] overflow-hidden rounded-xl border-[3px] border-[var(--storyboard-node-border)] bg-[var(--storyboard-node-surface)] shadow-[var(--shadow-2)]"
            data-storyboard-workbench-export-menu="true"
            role="menu"
          >
            {PREVIEW_EXPORT_ACTION_ITEMS.map((item) => {
              const disabled = item.disabled || (item.id === 'all' && !hasDownloadableMedia)

              return (
                <button
                  className={cn(
                    'block w-full px-[53px] py-[12px] text-left text-canvas-title-lg leading-none font-medium text-[var(--storyboard-node-ink)]',
                    disabled
                      ? 'cursor-not-allowed opacity-45'
                      : 'hover:bg-[var(--storyboard-node-selected-surface)]',
                  )}
                  data-storyboard-workbench-export-action={item.id}
                  data-storyboard-workbench-export-action-disabled={disabled ? 'true' : undefined}
                  disabled={disabled}
                  key={item.id}
                  onClick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    handleExportActionSelect(item.id)
                  }}
                  onPointerDown={(event) => event.stopPropagation()}
                  role="menuitem"
                  type="button"
                >
                  {item.label}
                </button>
              )
            })}
          </div>
        ) : null}
      </div>
    </div>
  )
}

/**
 * 渲染播放器预览窗口。
 *
 * @param props - 预览窗口属性。
 * @param props.aspectRatio - 当前视频宽高比。
 * @param props.height - 预览画面高度。
 * @param props.preview - 当前预览媒体。
 * @param props.width - 预览画面宽度。
 * @returns 参考节点的 previewRect。
 */
function StoryboardWorkbenchPreviewSurface({
  aspectRatio,
  height,
  isPlaying,
  mediaTimeSeconds,
  onPlaybackStateChange,
  onPreviewMediaTimeChange,
  preview,
  videoRef,
  width,
}: StoryboardWorkbenchPreviewSurfaceProps) {
  const imagePreviewSource = preview?.thumbnailUrl ?? preview?.url
  const isVideoPreview = preview?.mediaType === 'video'
  const previewVideoPosterUrl = isVideoPreview ? preview?.thumbnailUrl : undefined
  const previewVideoUrl = isVideoPreview ? preview?.url : undefined
  const previewFrameSize = getStoryboardPreviewFrameSize({
    aspectRatio,
    maxHeight: height,
    maxWidth: width,
  })

  useEffect(() => {
    const video = videoRef.current

    if (!video || !previewVideoUrl || !Number.isFinite(mediaTimeSeconds)) {
      return
    }

    if (Math.abs(video.currentTime - mediaTimeSeconds) > STORYBOARD_PLAYER_FRAME_STEP_SECONDS * 2) {
      video.currentTime = Math.max(0, mediaTimeSeconds)
    }
  }, [mediaTimeSeconds, previewVideoUrl, videoRef])

  useEffect(() => {
    const video = videoRef.current

    if (!video || !previewVideoUrl) {
      return
    }

    if (!isPlaying) {
      if (!video.paused) {
        video.pause()
      }
      return
    }

    void video.play().catch(() => {
      onPlaybackStateChange(false)
    })
  }, [isPlaying, onPlaybackStateChange, previewVideoUrl, videoRef])

  const handleVideoTimeUpdate = () => {
    const video = videoRef.current

    if (!video) {
      return
    }

    onPreviewMediaTimeChange(video.currentTime)
  }
  const handleVideoEnded = () => {
    onPlaybackStateChange(false)
  }

  return (
    <div className="previewContainer-kLz2KZ grid min-h-0 flex-1 place-items-center px-[53px] pt-[85px] pb-[43px]">
      <div
        data-storyboard-workbench-preview-frame="true"
        style={{
          height: previewFrameSize.height,
          width: previewFrameSize.width,
        }}
      >
        <AspectRatioPrimitive.Root
          className="previewRect-zzUhkt relative overflow-hidden rounded-4xl bg-[var(--storyboard-node-preview-bg)]"
          data-storyboard-workbench-preview-aspect-ratio={aspectRatio}
          ratio={aspectRatio}
        >
          {previewVideoUrl ? (
            <video
              className="fakePreivewVideoCover-c0XMSt h-full w-full object-contain"
              data-storyboard-workbench-preview-video="true"
              onEnded={handleVideoEnded}
              onTimeUpdate={handleVideoTimeUpdate}
              playsInline
              poster={previewVideoPosterUrl}
              preload="metadata"
              ref={videoRef}
              src={previewVideoUrl}
            />
          ) : imagePreviewSource ? (
            <img
              alt=""
              className="fakePreivewVideoCover-c0XMSt h-full w-full object-contain"
              draggable={false}
              src={imagePreviewSource}
            />
          ) : (
            <div
              className="absolute inset-0 bg-[var(--storyboard-node-empty-preview-bg)]"
              data-storyboard-workbench-empty-preview="true"
            />
          )}
        </AspectRatioPrimitive.Root>
      </div>
    </div>
  )
}

/**
 * 渲染播放器控制条。
 *
 * @param props - 控制条属性。
 * @param props.currentTimeSeconds - 当前播放秒数。
 * @param props.totalDurationSeconds - 总时长秒数。
 * @returns 参考节点的 player-controls。
 */
function StoryboardWorkbenchPlayerControls({
  canPlay,
  currentTimeSeconds,
  isPlaying,
  onPlayToggle,
  onPreviewTimeChange,
  totalDurationSeconds,
}: StoryboardWorkbenchPlayerControlsProps) {
  const sliderMaxSeconds = getSliderMaxSeconds(totalDurationSeconds)
  const handleSliderValueChange = (value: number[]) => {
    onPreviewTimeChange(readSliderTimeSeconds(value))
  }

  return (
    <div style={{ height: STORYBOARD_PLAYER_CONTROLS_HEIGHT, width: '100%' }}>
      <SliderPrimitive.Root
        aria-label="Preview frame time"
        className="player-controls-ySalBv screenPlayerControl-UGNqIX nodrag nopan relative grid h-full cursor-ew-resize grid-cols-[1fr_auto_1fr] items-center bg-[var(--storyboard-node-surface)] px-[43px] select-none"
        data-storyboard-workbench-player-slider="true"
        disabled={totalDurationSeconds <= 0}
        max={sliderMaxSeconds}
        min={0}
        onValueChange={handleSliderValueChange}
        step={STORYBOARD_PLAYER_FRAME_STEP_SECONDS}
        value={[clamp(currentTimeSeconds, 0, sliderMaxSeconds)]}
      >
        <div />
        <div className="control-area-H1HmRd flex items-center justify-center">
          <div
            className="left-part-LzxEaw flex min-w-0 items-center"
            style={{
              gap: STORYBOARD_PLAYER_TIME_GAP,
            }}
          >
            <button
              aria-label={isPlaying ? '暂停预览' : '播放预览'}
              className="player-play-btn-tlwB17 nodrag nopan grid place-items-center rounded-full border-0 bg-[var(--storyboard-node-ink)] p-0"
              data-storyboard-workbench-play-button="true"
              data-storyboard-workbench-playing={isPlaying ? 'true' : 'false'}
              disabled={!canPlay || totalDurationSeconds <= 0}
              onClick={(event) => {
                event.stopPropagation()
                onPlayToggle()
              }}
              onPointerDown={(event) => event.stopPropagation()}
              style={{
                height: STORYBOARD_PLAYER_PLAY_BUTTON_SIZE,
                width: STORYBOARD_PLAYER_PLAY_BUTTON_SIZE,
              }}
              type="button"
            >
              {isPlaying ? (
                <span aria-hidden="true" className="flex items-center gap-[7px]">
                  <span className="block h-[23px] w-[7px] rounded-full bg-white" />
                  <span className="block h-[23px] w-[7px] rounded-full bg-white" />
                </span>
              ) : (
                <StoryboardPlayIcon size={STORYBOARD_PLAYER_PLAY_ICON_SIZE} />
              )}
            </button>
            <div
              className="player-time-ue2HCK flex items-center leading-none font-medium text-[var(--storyboard-node-ink)]"
              style={{
                fontSize: STORYBOARD_PLAYER_TIME_FONT_SIZE,
              }}
            >
              <span className="player-time-text-z4MoEq">
                {formatPlayerTime(currentTimeSeconds)}
              </span>
              <span
                className="divider-kKuJz9 bg-black/20"
                style={{
                  height: STORYBOARD_PLAYER_TIME_DIVIDER_HEIGHT,
                  marginLeft: STORYBOARD_PLAYER_TIME_DIVIDER_MARGIN_X,
                  marginRight: STORYBOARD_PLAYER_TIME_DIVIDER_MARGIN_X,
                  width: 3,
                }}
              />
              <span className="player-duration-text-JyAiUS text-[var(--storyboard-node-muted)]">
                {formatPlayerTime(totalDurationSeconds)}
              </span>
            </div>
          </div>
        </div>
        <div />
      </SliderPrimitive.Root>
    </div>
  )
}

/**
 * 渲染单个时间轴片段。
 *
 * @param props - 时间轴片段属性。
 * @param props.segment - 带时长和位置的片段。
 * @returns 一个按实际时长占位的 shot 片段。
 */
function StoryboardWorkbenchTimelineSegmentItem({
  segment,
}: {
  segment: StoryboardWorkbenchTimelineSegment
}) {
  const mediaSource = segment.media?.thumbnailUrl ?? segment.media?.url

  return (
    <li
      aria-label={`${segment.shot.title} ${formatCoverDuration(segment.durationSeconds)}`}
      className="timelineShotSegment-qhi6uG relative shrink-0 overflow-hidden rounded-lg bg-[var(--storyboard-node-selected-surface)]"
      data-storyboard-workbench-timeline-shot={segment.shot.id}
      data-storyboard-workbench-timeline-shot-duration={segment.durationSeconds}
      style={{
        height: STORYBOARD_TIMELINE_SEGMENT_HEIGHT,
        width: segment.widthPx,
      }}
    >
      {mediaSource ? (
        <>
          <img alt="" className="h-full w-full object-cover" draggable={false} src={mediaSource} />
          <div className="absolute inset-0 bg-gradient-to-r from-black/20 via-transparent to-black/20" />
        </>
      ) : (
        <div className="grid h-full w-full place-items-center bg-[var(--storyboard-node-screen-empty)] text-[var(--storyboard-node-muted)]">
          <StoryboardAddScreenIcon size={43} />
        </div>
      )}
      <div className="layer-local-1 absolute bottom-[16px] left-[16px] rounded-sm bg-[var(--storyboard-node-timeline-badge)] px-[13px] py-[5px] text-canvas-body leading-none font-medium text-white">
        {formatCoverDuration(segment.durationSeconds)}
      </div>
    </li>
  )
}

/**
 * 渲染按 shot 时长排布的时间轴。
 *
 * @param props - 时间轴属性。
 * @param props.currentTimeSeconds - 当前播放秒数。
 * @param props.shots - 时间轴中的镜头列表。
 * @param props.timelineViewportWidth - 时间轴横向视口宽度。
 * @returns 视频剪辑时间轴。
 */
function StoryboardWorkbenchTimeline({
  currentTimeSeconds,
  onPreviewTimeChange,
  shots,
  timelineViewportWidth,
  totalDurationSeconds,
}: StoryboardWorkbenchTimelineProps) {
  const segments = getTimelineSegments(shots, timelineViewportWidth)
  const sliderMaxSeconds = getSliderMaxSeconds(totalDurationSeconds)
  const playheadLeftPercent = getTimelinePlayheadLeftPercent(
    currentTimeSeconds,
    totalDurationSeconds,
  )
  const handleSliderValueChange = (value: number[]) => {
    onPreviewTimeChange(readSliderTimeSeconds(value))
  }

  return (
    <div
      className="timelineContainer-PUo7Sy nodrag nopan bg-[var(--storyboard-node-surface)] px-[43px] pb-[21px]"
      data-storyboard-workbench-timeline="true"
      style={{
        height: STORYBOARD_TIMELINE_HEIGHT,
        paddingTop: STORYBOARD_TIMELINE_TOP_GUTTER,
      }}
    >
      <div className="timelineViewport-f26XjC h-full w-full overflow-x-auto overflow-y-visible">
        <SliderPrimitive.Root
          aria-label="Preview timeline"
          className="timelineTrack-c6itGT relative flex list-none items-end p-0"
          data-storyboard-workbench-timeline-slider="true"
          disabled={totalDurationSeconds <= 0}
          max={sliderMaxSeconds}
          min={0}
          onValueChange={handleSliderValueChange}
          step={STORYBOARD_PLAYER_FRAME_STEP_SECONDS}
          style={{
            boxSizing: 'border-box',
            gap: STORYBOARD_TIMELINE_SEGMENT_GAP,
            height: '100%',
            marginLeft: STORYBOARD_TIMELINE_EDGE_GUTTER,
            marginRight: STORYBOARD_TIMELINE_EDGE_GUTTER,
            width: timelineViewportWidth - STORYBOARD_TIMELINE_EDGE_GUTTER * 2,
          }}
          value={[clamp(currentTimeSeconds, 0, sliderMaxSeconds)]}
        >
          <SliderPrimitive.Track asChild>
            <ul className="contents">
              {segments.map((segment) => (
                <StoryboardWorkbenchTimelineSegmentItem key={segment.shot.id} segment={segment} />
              ))}
            </ul>
          </SliderPrimitive.Track>
          <SliderPrimitive.Thumb
            aria-valuetext={formatPlayerTime(currentTimeSeconds)}
            className="timelinePlayheadInput-rmn39U layer-local-3 absolute bottom-0 block cursor-ew-resize opacity-0"
            data-storyboard-workbench-timeline-thumb="true"
            style={{
              left: `${playheadLeftPercent}%`,
              height: STORYBOARD_TIMELINE_SEGMENT_HEIGHT + STORYBOARD_TIMELINE_PLAYHEAD_TOP_OFFSET,
              width: STORYBOARD_TIMELINE_PLAYHEAD_KNOB_SIZE,
              transform: 'translateX(-50%)',
            }}
          />
          <div
            aria-hidden="true"
            className="timelinePlayhead-TgP3Bn layer-local-2 pointer-events-none absolute bottom-0 block w-[3px] rounded-full bg-[var(--storyboard-node-ink)]"
            data-storyboard-workbench-timeline-playhead="true"
            style={{
              left: `${playheadLeftPercent}%`,
              height: STORYBOARD_TIMELINE_SEGMENT_HEIGHT + STORYBOARD_TIMELINE_PLAYHEAD_TOP_OFFSET,
              transform: 'translateX(-50%)',
            }}
          >
            <div
              className="absolute top-0 left-1/2 -translate-x-1/2 rounded-full bg-[var(--storyboard-node-ink)]"
              data-storyboard-workbench-timeline-playhead-knob="true"
              style={{
                height: STORYBOARD_TIMELINE_PLAYHEAD_KNOB_SIZE,
                width: STORYBOARD_TIMELINE_PLAYHEAD_KNOB_SIZE,
              }}
            />
          </div>
        </SliderPrimitive.Root>
      </div>
    </div>
  )
}

/**
 * 渲染右侧预览区。
 *
 * @param props - 预览区属性。
 * @param props.aspectRatio - 当前视频宽高比。
 * @param props.currentTimeSeconds - 当前播放秒数。
 * @param props.isScreenMode - 是否为参考节点的 simpleViewerMode。
 * @param props.onPreviewTimeChange - 播放时间变更回调。
 * @param props.preview - 当前预览媒体。
 * @param props.shots - 时间轴镜头列表。
 * @param props.totalDurationSeconds - 总时长秒数。
 * @returns 参考节点的 previewVideoContainer。
 */
export function StoryboardWorkbenchPreviewPanel({
  aspectRatio,
  currentTimeSeconds,
  exportableShots,
  isPlaying,
  isScreenMode,
  mediaTimeSeconds,
  onPlayToggle,
  onPlaybackStateChange,
  onPreviewMediaTimeChange,
  onPreviewTimeChange,
  preview,
  shots,
  totalDurationSeconds,
  videoRef,
}: StoryboardWorkbenchPreviewPanelProps) {
  const metrics = getStoryboardPreviewPanelMetrics(isScreenMode)
  const hasTimelineShots = shots.length > 0

  return (
    <div
      className="previewVideoContainer-_A_ffR previewArea-Cnp_n7 flex h-full shrink-0 flex-col bg-[var(--storyboard-node-surface)]"
      data-storyboard-workbench-preview-panel="true"
      style={{
        width: metrics.panelWidth,
      }}
    >
      <StoryboardPreviewToolbar shots={exportableShots} />
      <div className="previewStack-WQjc2Z flex min-h-0 flex-1 flex-col">
        <StoryboardWorkbenchPreviewSurface
          aspectRatio={aspectRatio}
          height={metrics.previewHeight}
          isPlaying={isPlaying}
          mediaTimeSeconds={mediaTimeSeconds}
          onPlaybackStateChange={onPlaybackStateChange}
          onPreviewMediaTimeChange={onPreviewMediaTimeChange}
          preview={preview}
          videoRef={videoRef}
          width={metrics.previewWidth}
        />
        <StoryboardWorkbenchPlayerControls
          canPlay={preview?.mediaType === 'video'}
          currentTimeSeconds={currentTimeSeconds}
          isPlaying={isPlaying}
          onPlayToggle={onPlayToggle}
          onPreviewTimeChange={onPreviewTimeChange}
          totalDurationSeconds={totalDurationSeconds}
        />
        {hasTimelineShots ? (
          <StoryboardWorkbenchTimeline
            currentTimeSeconds={currentTimeSeconds}
            onPreviewTimeChange={onPreviewTimeChange}
            shots={shots}
            timelineViewportWidth={metrics.timelineViewportWidth}
            totalDurationSeconds={totalDurationSeconds}
          />
        ) : null}
      </div>
    </div>
  )
}
