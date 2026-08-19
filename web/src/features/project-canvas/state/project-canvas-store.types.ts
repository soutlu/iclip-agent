import type { Node, NodeChange } from '@xyflow/react'
import type { StoreApi } from 'zustand/vanilla'
import type {
  ProjectArtifactDescriptor,
  ProjectCreativeBriefArtifact,
  ProjectImageAnalysisSummaryArtifact,
  ProjectMarkdownArtifact,
  ProjectStoryboardArtifact,
  ProjectUiCardArtifact,
  ProjectVideoPromptArtifact,
} from '@/features/artifacts'
import type { ProducerProjectMediaItem } from '@/features/chat'
import type {
  ProjectCanvasFlowNode,
  ProjectCanvasNodeSummary,
} from '@/features/project-canvas/components/nodes/project-canvas-node.types'
import type { ProjectCanvasLayoutMode } from '@/features/project-canvas/layout/project-canvas-masonry-layout.utils'

export const DEFAULT_CANVAS_ZOOM_LEVEL = 36
export const ZOOM_MIN = 10
export const ZOOM_MAX = 400
export const ZOOM_STEP = 10
export const ZOOM_SELECTION_LEVEL = 200
export const NEW_NODE_GAP = 20
export const PROJECT_CANVAS_STANDARD_NODE_SIZE = {
  height: 990,
  width: 1584,
} as const

export type SupportedProjectCanvasArtifact =
  | ProjectCreativeBriefArtifact
  | ProjectImageAnalysisSummaryArtifact
  | ProjectMarkdownArtifact
  | ProjectStoryboardArtifact
  | ProjectVideoPromptArtifact
  | ProjectUiCardArtifact

export interface CanvasViewportController {
  panBy: (dx: number, dy: number) => void
  zoomIn: () => void
  zoomOut: () => void
  zoomTo100: () => void
  zoomToFit: () => void
  zoomToSelection: (nodeId: string | null) => void
}

export interface ProjectCanvasLayoutNode {
  layoutMode: ProjectCanvasLayoutMode
  nodeId: string
  x: number
  y: number
}

export interface ProjectCanvasLayout {
  nodes: ProjectCanvasLayoutNode[]
  revision: number
  schemaVersion: 1
  updatedAt: string | null
}

export type ProjectCanvasPositionedNode = Node<
  Record<string, unknown> & { layoutMode: ProjectCanvasLayoutMode },
  string
>

export type ProjectCanvasWorkspaceNode = ProjectCanvasPositionedNode

export type ProjectCanvasWorkspaceNodeInput = Node<Record<string, unknown>, string>

export interface ProjectCanvasPlacementBounds {
  maxX: number
  minX: number
  minY: number
}

export interface ProjectCanvasState {
  artifacts: ProjectArtifactDescriptor[]
  clearHighlights: () => void
  /**
   * 提交用户拖动后的手动画布坐标。
   *
   * @param positions - 需要持久化为 manual 的节点坐标。
   * @returns accepted 为 true 时表示本地语义提交已接受；为 false 时表示提交被拒绝并应回滚。
   */
  commitManualNodePositions: (positions: Array<{ id: string; x: number; y: number }>) => {
    accepted: boolean
  }
  exportTargetVersion: number
  flashHighlights: (nodeIds: string[]) => void
  getExportTarget: (nodeId: string | null) => HTMLElement | null
  getLayoutSnapshot: () => Pick<ProjectCanvasLayout, 'nodes' | 'schemaVersion'>
  highlightedNodeIds: string[]
  highlightToken: number
  hydrateLayout: (layout: ProjectCanvasLayout) => void
  hydratedLayoutNodes: ProjectCanvasLayoutNode[]
  layoutCommitVersion: number
  layoutHydrated: boolean
  nodes: ProjectCanvasFlowNode[]
  onNodesChange: (changes: Array<NodeChange<ProjectCanvasFlowNode>>) => void
  onWorkspaceNodesChange: (changes: Array<NodeChange<ProjectCanvasWorkspaceNode>>) => void
  panCanvas: (dx: number, dy: number) => void
  placementBounds: ProjectCanvasPlacementBounds | null
  projectMedia: ProducerProjectMediaItem[]
  registerExportTarget: (nodeId: string, element: HTMLElement | null) => void
  registerViewportController: (controller: CanvasViewportController | null) => void
  requestLayoutCommit: () => void
  selectNode: (nodeId: string) => void
  selectedNodeId: string | null
  selectedNodeSummary: ProjectCanvasNodeSummary | null
  syncArtifacts: (artifacts: ProjectArtifactDescriptor[]) => void
  syncPlacementBounds: (bounds: ProjectCanvasPlacementBounds) => void
  syncProjectMedia: (media: ProducerProjectMediaItem[]) => void
  syncWorkspaceNodes: (nodes: ProjectCanvasWorkspaceNodeInput[]) => void
  syncZoomLevel: (zoom: number) => void
  updateNodePositions: (positions: Array<{ id: string; x: number; y: number }>) => void
  viewportController: CanvasViewportController | null
  workspaceNodes: ProjectCanvasWorkspaceNode[]
  zoomIn: () => void
  zoomLevel: number
  zoomOut: () => void
  zoomTo100: () => void
  zoomToFit: () => void
  zoomToSelection: () => void
}

export type ProjectCanvasStore = StoreApi<ProjectCanvasState>
