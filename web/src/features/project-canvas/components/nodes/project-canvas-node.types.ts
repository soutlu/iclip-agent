import type { Node } from '@xyflow/react'
import type {
  CreativeBriefOutput,
  GeneratedVideoOutput,
  ImageAnalysisSummaryOutput,
  MarkdownArtifactOutput,
  StoryboardOutput,
  UiCardArtifactOutput,
  VideoPromptOutput,
} from '@/features/artifacts'
import type { ProjectCanvasLayoutMode } from '@/features/project-canvas/layout/project-canvas-masonry-layout.utils'

export type ProjectCanvasArtifactKind =
  'brief' | 'storyboard' | 'video-prompt' | 'image-analysis-summary' | 'ui-card' | 'markdown'

export type ProjectCanvasVideoGenerationTaskStatus = 'failed' | 'queued' | 'running' | 'succeeded'

export type ProjectCanvasVideoGenerationOutputAsset = {
  assetId: string
  mimeType?: string
  thumbnailUrl?: string
  url: string
}

export type ProjectCanvasVideoGenerationTask = {
  aspectRatio: string
  audioUrls: string[]
  createdAt: string
  imageUrls: string[]
  outputAsset?: ProjectCanvasVideoGenerationOutputAsset
  prompt: string
  seconds: number
  shotIndex: number
  status: ProjectCanvasVideoGenerationTaskStatus
  taskId: string
  videoUrls: string[]
}

type BaseProjectCanvasNodeData = Record<string, unknown> & {
  artifactKind: ProjectCanvasArtifactKind
  highlightToken: number
  isHighlighted: boolean
  layoutMode: ProjectCanvasLayoutMode
  title: string
}

export type BriefProjectCanvasNodeData = BaseProjectCanvasNodeData & {
  artifactKind: 'brief'
  brief: CreativeBriefOutput
}

export type StoryboardProjectCanvasNodeData = BaseProjectCanvasNodeData & {
  artifactKind: 'storyboard'
  storyboard: StoryboardOutput
}

export type ImageAnalysisSummaryProjectCanvasNodeData = BaseProjectCanvasNodeData & {
  artifactKind: 'image-analysis-summary'
  imageAnalysisSummary: ImageAnalysisSummaryOutput
}

export type VideoPromptProjectCanvasNodeData = BaseProjectCanvasNodeData & {
  artifactKind: 'video-prompt'
  generatedVideo?: GeneratedVideoOutput
  videoPrompt: VideoPromptOutput
}

export type UiCardProjectCanvasNodeData = BaseProjectCanvasNodeData & {
  artifactKind: 'ui-card'
  uiCard: UiCardArtifactOutput
}

export type MarkdownProjectCanvasNodeData = BaseProjectCanvasNodeData & {
  artifactKind: 'markdown'
  markdown: MarkdownArtifactOutput
}

export type BriefProjectCanvasNode = Node<BriefProjectCanvasNodeData, 'brief-node'>
export type StoryboardProjectCanvasNode = Node<StoryboardProjectCanvasNodeData, 'storyboard-node'>
export type ImageAnalysisSummaryProjectCanvasNode = Node<
  ImageAnalysisSummaryProjectCanvasNodeData,
  'image-analysis-summary-node'
>
export type VideoPromptProjectCanvasNode = Node<
  VideoPromptProjectCanvasNodeData,
  'video-prompt-node'
>
export type UiCardProjectCanvasNode = Node<UiCardProjectCanvasNodeData, 'ui-card-node'>
export type MarkdownProjectCanvasNode = Node<MarkdownProjectCanvasNodeData, 'markdown-node'>

export type ProjectCanvasFlowNode =
  | BriefProjectCanvasNode
  | StoryboardProjectCanvasNode
  | VideoPromptProjectCanvasNode
  | ImageAnalysisSummaryProjectCanvasNode
  | UiCardProjectCanvasNode
  | MarkdownProjectCanvasNode

export interface ProjectCanvasNodeSummary {
  exportable: boolean
  id: string
  kind: ProjectCanvasArtifactKind
  title: string
}
