import { memo, useEffect, useRef, useState } from 'react'
import { cn } from '@/shared/lib/utils'
import { STORYBOARD_NODE_HEIGHT } from './storyboard-workbench.constants'
import type {
  StoryboardWorkbenchCanvasNodeProps,
  StoryboardWorkbenchViewMode,
} from './storyboard-workbench.types'
import {
  clamp,
  getPreviewMedia,
  getPreviewTimelineShots,
  getRenderableShots,
  getShotIdAtTime,
  getStoryboardNodeWidth,
  getStoryboardPreviewAspectRatio,
  getTimelineSegmentAtTime,
  getTotalDurationSeconds,
  stringifyDropPayload,
} from './storyboard-workbench.utils'
import { StoryboardWorkbenchPreviewPanel } from './StoryboardPreviewPanel'
import { StoryboardWorkbenchShotList, StoryboardWorkbenchTitleTag } from './StoryboardShotListPanel'

/**
 * 渲染可复用的故事板工作台 React Flow 节点。
 *
 * @param props - React Flow 节点属性。
 * @returns 不绑定业务逻辑的故事板工作台节点外观。
 */
function StoryboardWorkbenchCanvasNode({
  data,
  focusedPreview = false,
  id,
  selected,
}: StoryboardWorkbenchCanvasNodeProps) {
  const [viewMode, setViewMode] = useState<StoryboardWorkbenchViewMode>('script')
  const nodeId = id
  const renderableShots = getRenderableShots(data.shots)
  const previewTimelineShots = getPreviewTimelineShots(data.shots)
  const isScreenMode = viewMode === 'screen'
  const nodeWidth = getStoryboardNodeWidth(isScreenMode)
  const totalDurationSeconds = getTotalDurationSeconds(previewTimelineShots)
  const initialCurrentTimeSeconds =
    typeof data.currentTimeSeconds === 'number' && Number.isFinite(data.currentTimeSeconds)
      ? data.currentTimeSeconds
      : 0
  const previewVideoRef = useRef<HTMLVideoElement | null>(null)
  const [previewTimeSeconds, setPreviewTimeSeconds] = useState(() =>
    clamp(initialCurrentTimeSeconds, 0, totalDurationSeconds),
  )
  const previewSegment = getTimelineSegmentAtTime(previewTimelineShots, previewTimeSeconds)
  const preview = previewSegment?.media ?? data.preview ?? getPreviewMedia(previewTimelineShots)
  const previewAspectRatio = getStoryboardPreviewAspectRatio(preview, data.aspectRatio)
  const previewShotId =
    previewSegment?.shot.id ?? getShotIdAtTime(previewTimelineShots, previewTimeSeconds)
  const selectedShotId = data.activeShotId ?? previewShotId
  const previewMediaTimeSeconds = previewSegment
    ? previewTimeSeconds - previewSegment.startSeconds
    : previewTimeSeconds
  const [isPreviewPlaying, setPreviewPlaying] = useState(false)
  const handlePreviewTimeChange = (nextTimeSeconds: number) => {
    setPreviewTimeSeconds(clamp(nextTimeSeconds, 0, totalDurationSeconds))
  }
  const handlePreviewMediaTimeChange = (nextMediaTimeSeconds: number) => {
    if (!previewSegment) {
      setPreviewTimeSeconds(clamp(nextMediaTimeSeconds, 0, totalDurationSeconds))
      return
    }

    const segmentEndSeconds = previewSegment.startSeconds + previewSegment.durationSeconds
    const nextTimelineTimeSeconds = previewSegment.startSeconds + Math.max(0, nextMediaTimeSeconds)

    if (nextTimelineTimeSeconds >= segmentEndSeconds) {
      setPreviewTimeSeconds(clamp(segmentEndSeconds, 0, totalDurationSeconds))
      if (segmentEndSeconds >= totalDurationSeconds) {
        setPreviewPlaying(false)
      }
      return
    }

    setPreviewTimeSeconds(clamp(nextTimelineTimeSeconds, 0, totalDurationSeconds))
  }
  const handlePlayToggle = () => {
    if (totalDurationSeconds <= 0 || !preview || preview.mediaType !== 'video') {
      setPreviewPlaying(false)
      return
    }

    const video = previewVideoRef.current

    if (!video) {
      setPreviewPlaying(false)
      return
    }

    if (isPreviewPlaying) {
      video.pause()
      setPreviewPlaying(false)
      return
    }

    if (previewTimeSeconds >= totalDurationSeconds) {
      setPreviewTimeSeconds(0)
      video.currentTime = 0
    }

    void video
      .play()
      .then(() => {
        setPreviewPlaying(true)
      })
      .catch(() => {
        setPreviewPlaying(false)
      })
  }
  const toggleViewMode = () => {
    setViewMode((currentViewMode) => (currentViewMode === 'script' ? 'screen' : 'script'))
  }

  useEffect(() => {
    setPreviewTimeSeconds(clamp(initialCurrentTimeSeconds, 0, totalDurationSeconds))
  }, [initialCurrentTimeSeconds, totalDurationSeconds])

  useEffect(() => {
    if (totalDurationSeconds <= 0 || preview?.mediaType !== 'video') {
      setPreviewPlaying(false)
    }
  }, [preview?.mediaType, totalDurationSeconds])

  return (
    <article
      className="canvas-node-drag-surface relative block text-left text-[var(--storyboard-node-ink)]"
      data-storyboard-workbench-focused-preview={focusedPreview ? 'true' : undefined}
      data-storyboard-workbench-node="true"
      data-type="NodeStoryboard"
      style={{
        display: 'block',
        height: STORYBOARD_NODE_HEIGHT,
        outline: selected ? '3px solid var(--storyboard-node-selected-surface)' : 'none',
        outlineOffset: selected ? 8 : 0,
        width: nodeWidth,
      }}
      title={data.title}
    >
      <StoryboardWorkbenchTitleTag
        onToggleViewMode={toggleViewMode}
        title={data.title}
        viewMode={viewMode}
      />
      <div
        className={cn(
          'nodeContainer-SKMici canvas-node-copyable h-full w-full overflow-hidden bg-[var(--storyboard-node-surface)]',
          focusedPreview
            ? 'rounded-l-3xl rounded-r-none'
            : 'rounded-3xl shadow-[var(--storyboard-node-shadow)]',
        )}
      >
        <div
          className="h-full w-full"
          data-node-id={nodeId}
          data-payload={stringifyDropPayload({
            hoverType: 'STORYBOARD_NODE',
            nodeId,
          })}
          data-type="free-drop"
        >
          <div
            className={cn(
              'creationContent-gpyTU0 flex overflow-hidden border-[3px] border-[var(--storyboard-node-border)] bg-[var(--storyboard-node-surface)]',
              focusedPreview ? 'rounded-l-3xl rounded-r-none' : 'rounded-3xl',
              isScreenMode ? 'screenMode-hLeiRT' : '',
            )}
            style={{
              height: STORYBOARD_NODE_HEIGHT,
              width: nodeWidth,
            }}
          >
            <StoryboardWorkbenchShotList
              activeShotId={selectedShotId}
              aspectRatio={data.aspectRatio}
              isScreenMode={isScreenMode}
              nodeId={nodeId}
              onAddShot={data.onAddShot}
              onRedoShot={data.onRedoShot}
              onSelectShot={data.onSelectShot}
              onUploadShotMedia={data.onUploadShotMedia}
              shots={renderableShots}
            />
            <div className="dividerContainer-t0Kus9 h-full w-[3px] shrink-0 bg-[var(--storyboard-node-panel-divider)]">
              <div className="dividerLine-EJbPcI h-full w-[3px] bg-[var(--storyboard-node-panel-divider)]" />
            </div>
            <StoryboardWorkbenchPreviewPanel
              aspectRatio={previewAspectRatio}
              currentTimeSeconds={previewTimeSeconds}
              exportableShots={renderableShots}
              isPlaying={isPreviewPlaying}
              isScreenMode={isScreenMode}
              mediaTimeSeconds={previewMediaTimeSeconds}
              onPlaybackStateChange={setPreviewPlaying}
              onPlayToggle={handlePlayToggle}
              onPreviewMediaTimeChange={handlePreviewMediaTimeChange}
              onPreviewTimeChange={handlePreviewTimeChange}
              preview={preview}
              shots={previewTimelineShots}
              totalDurationSeconds={totalDurationSeconds}
              videoRef={previewVideoRef}
            />
          </div>
        </div>
      </div>
      <div
        aria-atomic="true"
        aria-live="assertive"
        id={`${nodeId}-DndLiveRegion`}
        role="status"
        style={{
          border: 0,
          clip: 'rect(0px, 0px, 0px, 0px)',
          clipPath: 'inset(100%)',
          height: 1,
          margin: -1,
          overflow: 'hidden',
          padding: 0,
          position: 'fixed',
          whiteSpace: 'nowrap',
          width: 1,
        }}
      />
    </article>
  )
}

export default memo(StoryboardWorkbenchCanvasNode)
