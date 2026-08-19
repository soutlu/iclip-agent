import type { Node, NodeProps } from '@xyflow/react'
import type { RefObject } from 'react'
import type { ComposerMediaType } from '@/shared/composer/composer.types'

export type StoryboardWorkbenchShotStatus = 'draft' | 'failed' | 'queued' | 'running' | 'succeeded'
export type StoryboardWorkbenchViewMode = 'script' | 'screen'
export type StoryboardWorkbenchExportAction = 'all' | 'merged'

export interface StoryboardWorkbenchMediaItem {
  aspectRatio?: string
  durationSeconds?: number
  fileName: string
  id: string
  mediaType: ComposerMediaType
  mimeType?: string
  thumbnailUrl?: string
  url: string
}

export interface StoryboardWorkbenchShot {
  durationSeconds?: number
  id: string
  includeInPreviewTimeline?: boolean
  media: StoryboardWorkbenchMediaItem[]
  narration?: string
  prompt?: string
  referenceMedia?: StoryboardWorkbenchMediaItem[]
  shotIndex: number
  status: StoryboardWorkbenchShotStatus
  title: string
}

export interface StoryboardWorkbenchRedoShotInput {
  aspectRatio?: string
  media: StoryboardWorkbenchMediaItem[]
  prompt: string
  seconds: number
  shotId: string
  shotIndex: number
  title: string
}

export interface StoryboardWorkbenchAddShotInput {
  afterShotId: string
}

export interface StoryboardWorkbenchUploadShotMediaInput {
  files: File[]
  shotId: string
}

export interface StoryboardWorkbenchSelectShotInput {
  shotId: string
}

export interface StoryboardWorkbenchCanvasNodeData extends Record<string, unknown> {
  activeShotId?: string
  aspectRatio?: string
  currentTimeSeconds?: number
  onAddShot?: (input: StoryboardWorkbenchAddShotInput) => void
  onRedoShot?: (input: StoryboardWorkbenchRedoShotInput) => void
  onSelectShot?: (input: StoryboardWorkbenchSelectShotInput) => void
  onUploadShotMedia?: (input: StoryboardWorkbenchUploadShotMediaInput) => void | Promise<void>
  preview?: StoryboardWorkbenchMediaItem
  shots: StoryboardWorkbenchShot[]
  title: string
}

export type StoryboardWorkbenchProjectCanvasNode = Node<
  StoryboardWorkbenchCanvasNodeData,
  'storyboard-workbench-node'
>

export interface StoryboardWorkbenchTitleTagProps {
  onToggleViewMode: () => void
  title: string
  viewMode: StoryboardWorkbenchViewMode
}

export interface StoryboardWorkbenchShotListProps {
  activeShotId?: string
  aspectRatio?: string
  isScreenMode: boolean
  nodeId: string
  onAddShot?: (input: StoryboardWorkbenchAddShotInput) => void
  onRedoShot?: (input: StoryboardWorkbenchRedoShotInput) => void
  onSelectShot?: (input: StoryboardWorkbenchSelectShotInput) => void
  onUploadShotMedia?: (input: StoryboardWorkbenchUploadShotMediaInput) => void | Promise<void>
  shots: StoryboardWorkbenchShot[]
}

export interface StoryboardWorkbenchShotItemProps {
  isSelected: boolean
  isScreenMode: boolean
  nodeAspectRatio?: string
  nodeId: string
  onRedoShot?: (input: StoryboardWorkbenchRedoShotInput) => void
  onSelectShot?: (input: StoryboardWorkbenchSelectShotInput) => void
  onUploadShotMedia?: (input: StoryboardWorkbenchUploadShotMediaInput) => void | Promise<void>
  shot: StoryboardWorkbenchShot
  shotIndex: number
}

export interface StoryboardWorkbenchShotMaterialProps {
  nodeAspectRatio?: string
  nodeId: string
  onRedoShot?: (input: StoryboardWorkbenchRedoShotInput) => void
  onUploadShotMedia?: (input: StoryboardWorkbenchUploadShotMediaInput) => void | Promise<void>
  shot: StoryboardWorkbenchShot
}

export interface StoryboardWorkbenchPreviewPanelProps {
  aspectRatio: number
  currentTimeSeconds: number
  exportableShots: StoryboardWorkbenchShot[]
  isPlaying: boolean
  isScreenMode: boolean
  mediaTimeSeconds: number
  onPlayToggle: () => void
  onPlaybackStateChange: (isPlaying: boolean) => void
  onPreviewMediaTimeChange: (nextMediaTimeSeconds: number) => void
  onPreviewTimeChange: (nextTimeSeconds: number) => void
  preview: StoryboardWorkbenchMediaItem | null
  shots: StoryboardWorkbenchShot[]
  totalDurationSeconds: number
  videoRef: RefObject<HTMLVideoElement | null>
}

export interface StoryboardPreviewToolbarProps {
  shots: StoryboardWorkbenchShot[]
}

export interface StoryboardWorkbenchPreviewSurfaceProps {
  aspectRatio: number
  height: number
  isPlaying: boolean
  mediaTimeSeconds: number
  onPlaybackStateChange: (isPlaying: boolean) => void
  onPreviewMediaTimeChange: (nextMediaTimeSeconds: number) => void
  preview: StoryboardWorkbenchMediaItem | null
  videoRef: RefObject<HTMLVideoElement | null>
  width: number
}

export interface StoryboardWorkbenchPlayerControlsProps {
  canPlay: boolean
  currentTimeSeconds: number
  isPlaying: boolean
  onPlayToggle: () => void
  onPreviewTimeChange: (nextTimeSeconds: number) => void
  totalDurationSeconds: number
}

export interface StoryboardWorkbenchTimelineProps {
  currentTimeSeconds: number
  onPreviewTimeChange: (nextTimeSeconds: number) => void
  shots: StoryboardWorkbenchShot[]
  timelineViewportWidth: number
  totalDurationSeconds: number
}

export interface StoryboardWorkbenchShotTimeSegment {
  durationSeconds: number
  media: StoryboardWorkbenchMediaItem | null
  shot: StoryboardWorkbenchShot
  shotIndex: number
  startSeconds: number
}

export interface StoryboardWorkbenchTimelineSegment extends StoryboardWorkbenchShotTimeSegment {
  widthPx: number
}

export interface StoryboardWorkbenchPreviewPanelMetrics {
  panelWidth: number
  previewHeight: number
  previewWidth: number
  timelineViewportWidth: number
}

export interface StoryboardWorkbenchPreviewFrameSize {
  height: number
  width: number
}

export interface StoryboardWorkbenchCanvasNodeProps extends Pick<
  NodeProps<StoryboardWorkbenchProjectCanvasNode>,
  'data' | 'id' | 'selected'
> {
  focusedPreview?: boolean
}
