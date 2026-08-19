import type {
  ProjectArtifactDescriptor,
  ProjectCreativeBriefArtifact,
  ProjectImageAnalysisSummaryArtifact,
  ProjectMarkdownArtifact,
  ProjectStoryboardArtifact,
  ProjectUiCardArtifact,
  ProjectVideoPromptArtifact,
} from '@/features/artifacts'
import {
  filterVisibleGeneratedVideos,
  type GeneratedVideoOutput,
  IMAGE_ANALYSIS_SUMMARY_NODE_TITLE,
  mergeImageAnalysisSummaryArtifacts,
} from '@/features/artifacts'
import type {
  BriefProjectCanvasNode,
  ImageAnalysisSummaryProjectCanvasNode,
  MarkdownProjectCanvasNode,
  ProjectCanvasArtifactKind,
  ProjectCanvasFlowNode,
  ProjectCanvasNodeSummary,
  StoryboardProjectCanvasNode,
  UiCardProjectCanvasNode,
  VideoPromptProjectCanvasNode,
} from '@/features/project-canvas/components/nodes/project-canvas-node.types'
import type { ProjectCanvasLayoutMode } from '@/features/project-canvas/layout/project-canvas-masonry-layout.utils'
import {
  buildSelectedNodeSummary,
  decorateNodes,
  DEFAULT_PLACEMENT_BOUNDS,
  resolveProjectCanvasNodesLayout,
} from './project-canvas-store.layout'
import {
  DEFAULT_CANVAS_ZOOM_LEVEL,
  PROJECT_CANVAS_STANDARD_NODE_SIZE,
  type ProjectCanvasPlacementBounds,
  type ProjectCanvasState,
  type SupportedProjectCanvasArtifact,
} from './project-canvas-store.types'

/**
 * 创建 artifact 画布节点的稳定 id。
 *
 * @param projectId - 当前项目会话 id。
 * @param artifactKind - artifact 的画布节点类型。
 * @param artifactId - artifact 的稳定领域 id。
 * @returns 可跨增量同步复用的 React Flow 节点 id。
 */
export const createArtifactNodeId = (
  projectId: string,
  artifactKind: ProjectCanvasArtifactKind,
  artifactId: string,
) => `${projectId}:${artifactKind}:${artifactId}`

/**
 * 解析创意策略简报节点标题。
 *
 * @param artifact - 已归一化的创意策略简报 artifact。
 * @returns 优先使用核心主张的节点展示标题。
 */
export const resolveBriefNodeTitle = (artifact: ProjectCreativeBriefArtifact) => {
  const coreClaim = artifact.output.strategicAlignment?.coreClaim?.trim()

  return coreClaim && coreClaim.length > 0 ? coreClaim : '创意策略简报'
}

/**
 * 解析动态分镜表节点标题。
 *
 * @param artifact - 已归一化的动态分镜表 artifact。
 * @returns 带分镜段数的节点展示标题。
 */
export const resolveStoryboardNodeTitle = (artifact: ProjectStoryboardArtifact) => {
  const shotCount = artifact.output.shotTable?.length ?? 0

  return shotCount > 0 ? `动态分镜表 · ${shotCount} 段` : '动态分镜表'
}

/**
 * 解析图片解析汇总节点标题。
 *
 * @param artifact - 已归一化的图片解析汇总 artifact。
 * @returns 带图片数量的节点展示标题。
 */
export const resolveImageAnalysisSummaryNodeTitle = (
  artifact: ProjectImageAnalysisSummaryArtifact,
) => `${IMAGE_ANALYSIS_SUMMARY_NODE_TITLE} · ${artifact.output.items.length} 张`

/**
 * 解析视频提示词节点标题。
 *
 * @param artifact - 已归一化的视频提示词 artifact。
 * @returns 带镜头数量的节点展示标题。
 */
export const resolveVideoPromptNodeTitle = (artifact: ProjectVideoPromptArtifact) =>
  `视频提示词 · ${artifact.output.batches.length} 镜头`

/**
 * 解析 Markdown artifact 在画布节点中的标题。
 *
 * @param artifact - 已归一化的 Markdown artifact。
 * @returns 可用于画布节点标题和导出文件名的展示标题。
 */
export const resolveMarkdownNodeTitle = (artifact: ProjectMarkdownArtifact) => artifact.output.title

/**
 * 从完整 artifact 列表中聚合视频生成结果。
 *
 * @param artifacts - 当前项目快照中的完整 artifact 列表。
 * @returns 聚合后的视频生成输出；没有视频生成条目时返回 null。
 */
export const collectGeneratedVideoOutput = (
  artifacts: ProjectArtifactDescriptor[],
): GeneratedVideoOutput | null => {
  const videos = filterVisibleGeneratedVideos(
    artifacts.flatMap((artifact) =>
      artifact.kind === 'generated-video' ? artifact.output.videos : [],
    ),
  )

  return videos.length > 0 ? { videos } : null
}

/**
 * 创建创意策略简报 artifact 对应的 React Flow 节点。
 *
 * @param params - 创建节点所需的 artifact、布局模式、节点 id 和画布位置。
 * @param params.artifact - 已归一化的创意策略简报 artifact。
 * @param params.layoutMode - 节点当前的自动或手动布局模式。
 * @param params.nodeId - 画布节点稳定 id。
 * @param params.position - 节点初始画布坐标。
 * @returns 可渲染的创意策略简报画布节点。
 */
export const createBriefNode = ({
  artifact,
  layoutMode,
  nodeId,
  position,
}: {
  artifact: ProjectCreativeBriefArtifact
  layoutMode: ProjectCanvasLayoutMode
  nodeId: string
  position: { x: number; y: number }
}): BriefProjectCanvasNode => ({
  data: {
    artifactKind: 'brief',
    brief: artifact.output,
    highlightToken: 0,
    isHighlighted: false,
    layoutMode,
    title: resolveBriefNodeTitle(artifact),
  },
  dragHandle: '.canvas-node-drag-surface',
  id: nodeId,
  position,
  style: {
    height: PROJECT_CANVAS_STANDARD_NODE_SIZE.height,
    width: PROJECT_CANVAS_STANDARD_NODE_SIZE.width,
  },
  type: 'brief-node',
})

/**
 * 创建动态分镜表 artifact 对应的 React Flow 节点。
 *
 * @param params - 创建节点所需的 artifact、布局模式、节点 id 和画布位置。
 * @param params.artifact - 已归一化的动态分镜表 artifact。
 * @param params.layoutMode - 节点当前的自动或手动布局模式。
 * @param params.nodeId - 画布节点稳定 id。
 * @param params.position - 节点初始画布坐标。
 * @returns 可渲染的动态分镜表画布节点。
 */
export const createStoryboardNode = ({
  artifact,
  layoutMode,
  nodeId,
  position,
}: {
  artifact: ProjectStoryboardArtifact
  layoutMode: ProjectCanvasLayoutMode
  nodeId: string
  position: { x: number; y: number }
}): StoryboardProjectCanvasNode => ({
  data: {
    artifactKind: 'storyboard',
    highlightToken: 0,
    isHighlighted: false,
    layoutMode,
    storyboard: artifact.output,
    title: resolveStoryboardNodeTitle(artifact),
  },
  dragHandle: '.canvas-node-drag-surface',
  id: nodeId,
  position,
  style: {
    height: PROJECT_CANVAS_STANDARD_NODE_SIZE.height,
    width: PROJECT_CANVAS_STANDARD_NODE_SIZE.width,
  },
  type: 'storyboard-node',
})

/**
 * 创建图片解析汇总 artifact 对应的 React Flow 节点。
 *
 * @param params - 创建节点所需的 artifact、布局模式、节点 id 和画布位置。
 * @param params.artifact - 已归一化的图片解析汇总 artifact。
 * @param params.layoutMode - 节点当前的自动或手动布局模式。
 * @param params.nodeId - 画布节点稳定 id。
 * @param params.position - 节点初始画布坐标。
 * @returns 使用统一 16:10 外框并在内部滚动的图片解析汇总画布节点。
 */
export const createImageAnalysisSummaryNode = ({
  artifact,
  layoutMode,
  nodeId,
  position,
}: {
  artifact: ProjectImageAnalysisSummaryArtifact
  layoutMode: ProjectCanvasLayoutMode
  nodeId: string
  position: { x: number; y: number }
}): ImageAnalysisSummaryProjectCanvasNode => ({
  data: {
    artifactKind: 'image-analysis-summary',
    highlightToken: 0,
    imageAnalysisSummary: artifact.output,
    isHighlighted: false,
    layoutMode,
    title: resolveImageAnalysisSummaryNodeTitle(artifact),
  },
  dragHandle: '.canvas-node-drag-surface',
  id: nodeId,
  position,
  style: {
    height: PROJECT_CANVAS_STANDARD_NODE_SIZE.height,
    width: PROJECT_CANVAS_STANDARD_NODE_SIZE.width,
  },
  type: 'image-analysis-summary-node',
})

/**
 * 创建视频提示词 artifact 对应的 React Flow 节点。
 *
 * @param params - 创建节点所需的 artifact、布局模式、节点 id 和画布位置。
 * @param params.artifact - 已归一化的视频提示词 artifact。
 * @param params.generatedVideo - 当前项目已有的视频生成任务状态。
 * @param params.layoutMode - 节点当前的自动或手动布局模式。
 * @param params.nodeId - 画布节点稳定 id。
 * @param params.position - 节点初始画布坐标。
 * @returns 可渲染的视频提示词画布节点。
 */
export const createVideoPromptNode = ({
  artifact,
  generatedVideo,
  layoutMode,
  nodeId,
  position,
}: {
  artifact: ProjectVideoPromptArtifact
  generatedVideo: GeneratedVideoOutput | null
  layoutMode: ProjectCanvasLayoutMode
  nodeId: string
  position: { x: number; y: number }
}): VideoPromptProjectCanvasNode => ({
  data: {
    artifactKind: 'video-prompt',
    ...(generatedVideo ? { generatedVideo } : {}),
    highlightToken: 0,
    isHighlighted: false,
    layoutMode,
    title: resolveVideoPromptNodeTitle(artifact),
    videoPrompt: artifact.output,
  },
  dragHandle: '.canvas-node-drag-surface',
  id: nodeId,
  position,
  style: {
    height: PROJECT_CANVAS_STANDARD_NODE_SIZE.height,
    width: PROJECT_CANVAS_STANDARD_NODE_SIZE.width,
  },
  type: 'video-prompt-node',
})

/**
 * 创建 UI 卡片 artifact 对应的 React Flow 节点。
 *
 * @param params - 创建节点所需的 artifact、布局模式、节点 id 和画布位置。
 * @param params.artifact - 已归一化的 UI 卡片 artifact。
 * @param params.layoutMode - 节点当前的自动或手动布局模式。
 * @param params.nodeId - 画布节点稳定 id。
 * @param params.position - 节点初始画布坐标。
 * @returns 可渲染的 UI 卡片画布节点。
 */
export const createUiCardNode = ({
  artifact,
  layoutMode,
  nodeId,
  position,
}: {
  artifact: ProjectUiCardArtifact
  layoutMode: ProjectCanvasLayoutMode
  nodeId: string
  position: { x: number; y: number }
}): UiCardProjectCanvasNode => ({
  data: {
    artifactKind: 'ui-card',
    highlightToken: 0,
    isHighlighted: false,
    layoutMode,
    title: artifact.output.title,
    uiCard: artifact.output,
  },
  dragHandle: '.canvas-node-drag-surface',
  id: nodeId,
  position,
  style: {
    height: PROJECT_CANVAS_STANDARD_NODE_SIZE.height,
    width: PROJECT_CANVAS_STANDARD_NODE_SIZE.width,
  },
  type: 'ui-card-node',
})

/**
 * 创建 Markdown artifact 对应的 React Flow 节点。
 *
 * @param params - 创建节点所需的 artifact、布局模式、节点 id 和画布位置。
 * @param params.artifact - 已归一化的 Markdown artifact。
 * @param params.layoutMode - 节点当前的自动或手动布局模式。
 * @param params.nodeId - 画布节点稳定 id。
 * @param params.position - 节点初始画布坐标。
 * @returns 可渲染的 Markdown 画布节点。
 */
export const createMarkdownNode = ({
  artifact,
  layoutMode,
  nodeId,
  position,
}: {
  artifact: ProjectMarkdownArtifact
  layoutMode: ProjectCanvasLayoutMode
  nodeId: string
  position: { x: number; y: number }
}): MarkdownProjectCanvasNode => ({
  data: {
    artifactKind: 'markdown',
    highlightToken: 0,
    isHighlighted: false,
    layoutMode,
    markdown: artifact.output,
    title: resolveMarkdownNodeTitle(artifact),
  },
  dragHandle: '.canvas-node-drag-surface',
  id: nodeId,
  position,
  style: {
    height: PROJECT_CANVAS_STANDARD_NODE_SIZE.height,
    width: PROJECT_CANVAS_STANDARD_NODE_SIZE.width,
  },
  type: 'markdown-node',
})

/**
 * 根据 artifact 类型创建对应的画布节点。
 *
 * @param params - artifact、布局模式、初始位置和项目 id。
 * @param params.artifact - 支持渲染到画布的 artifact。
 * @param params.generatedVideo - 当前项目已有的视频生成任务状态。
 * @param params.layoutMode - 节点当前的自动或手动布局模式。
 * @param params.position - 节点初始画布坐标。
 * @param params.projectId - 当前项目会话 id。
 * @returns 对应类型的画布节点；遇到穷尽外类型时返回 never。
 */
export const createCanvasNodeFromArtifact = ({
  artifact,
  generatedVideo,
  layoutMode,
  position,
  projectId,
}: {
  artifact: SupportedProjectCanvasArtifact
  generatedVideo: GeneratedVideoOutput | null
  layoutMode: ProjectCanvasLayoutMode
  position: { x: number; y: number }
  projectId: string
}): ProjectCanvasFlowNode | null => {
  const nodeId = createArtifactNodeId(projectId, artifact.kind, artifact.artifactId)

  switch (artifact.kind) {
    case 'brief':
      return createBriefNode({ artifact, layoutMode, nodeId, position })
    case 'video-prompt':
      return createVideoPromptNode({ artifact, generatedVideo, layoutMode, nodeId, position })
    case 'image-analysis-summary':
      return createImageAnalysisSummaryNode({ artifact, layoutMode, nodeId, position })
    case 'storyboard':
      return createStoryboardNode({ artifact, layoutMode, nodeId, position })
    case 'ui-card':
      return createUiCardNode({ artifact, layoutMode, nodeId, position })
    case 'markdown':
      return createMarkdownNode({ artifact, layoutMode, nodeId, position })
    default: {
      const exhaustiveCheck: never = artifact
      return exhaustiveCheck
    }
  }
}

/**
 * 过滤出当前画布支持渲染的 artifact 类型。
 *
 * @param artifacts - 从聊天状态派生出的完整 artifact 列表。
 * @returns 可转换为独立画布节点的 artifact 列表；视频生成结果不在 store 中创建独立媒体节点。
 */
export const getSupportedArtifacts = (
  artifacts: ProjectArtifactDescriptor[],
): SupportedProjectCanvasArtifact[] =>
  artifacts.filter(
    (artifact): artifact is SupportedProjectCanvasArtifact =>
      artifact.kind === 'brief' ||
      artifact.kind === 'video-prompt' ||
      artifact.kind === 'image-analysis-summary' ||
      artifact.kind === 'storyboard' ||
      artifact.kind === 'ui-card' ||
      artifact.kind === 'markdown',
  )

/**
 * 归一化进入画布的 artifact 列表，确保单例类 artifact 不因上游记录分裂成多个节点。
 *
 * @param artifacts - 从项目运行态同步来的 artifact 列表。
 * @returns 可直接用于画布 reconcile 的 artifact 列表。
 */
export const normalizeCanvasArtifacts = (artifacts: ProjectArtifactDescriptor[]) =>
  mergeImageAnalysisSummaryArtifacts(artifacts)

/**
 * 判断当前资源快照中是否还有等待视窗范围后才能创建的节点。
 *
 * @param params - 当前项目 id、资源快照和已渲染节点。
 * @param params.artifacts - 当前项目 artifact 列表。
 * @param params.nodes - 当前画布节点。
 * @param params.projectId - 当前项目会话 id。
 * @returns 存在未创建的画布节点时返回 true。
 */
export const hasDeferredCanvasNodes = ({
  artifacts,
  nodes,
  projectId,
}: {
  artifacts: ProjectArtifactDescriptor[]
  nodes: ProjectCanvasFlowNode[]
  projectId: string
}) => {
  const normalizedArtifacts = normalizeCanvasArtifacts(artifacts)
  const existingNodeIds = new Set(nodes.map((node) => node.id))

  for (const artifact of getSupportedArtifacts(normalizedArtifacts)) {
    if (!existingNodeIds.has(createArtifactNodeId(projectId, artifact.kind, artifact.artifactId))) {
      return true
    }
  }

  return false
}

export interface ReconcileProjectCanvasNodesOptions {
  artifacts: ProjectArtifactDescriptor[]
  placementBounds: ProjectCanvasPlacementBounds | null
  projectId: string
  state: ProjectCanvasState
}

export interface ReconciledProjectCanvasNodes {
  focusNodeId: string | null
  highlightedNodeIds: string[]
  highlightToken: number
  nodes: ProjectCanvasFlowNode[]
  selectedNodeId: string | null
  selectedNodeSummary: ProjectCanvasNodeSummary | null
  zoomLevel: number
}

/**
 * 按当前 artifact 和媒体快照重建画布节点列表。
 *
 * @param options - 本次重建所需的项目 id、当前 store 状态和资源快照。
 * @returns 已继承位置、选中态、高亮态和新节点聚焦目标的新画布状态片段。
 */
export const reconcileProjectCanvasNodes = ({
  artifacts,
  placementBounds,
  projectId,
  state,
}: ReconcileProjectCanvasNodesOptions): ReconciledProjectCanvasNodes => {
  const supportedArtifacts = getSupportedArtifacts(artifacts)
  const generatedVideo = collectGeneratedVideoOutput(artifacts)
  const plannedNodeIds = supportedArtifacts.map((artifact) =>
    createArtifactNodeId(projectId, artifact.kind, artifact.artifactId),
  )
  const existingNodeIdsInNextLayoutOrder = state.nodes
    .map((node) => node.id)
    .filter((nodeId) => plannedNodeIds.includes(nodeId))
  const shouldPreserveExistingAutoNodePositions = existingNodeIdsInNextLayoutOrder.every(
    (nodeId, index) => plannedNodeIds[index] === nodeId,
  )
  const storedPositionMap = new Map(state.hydratedLayoutNodes.map((node) => [node.nodeId, node]))
  const existingNodesById = new Map(state.nodes.map((node) => [node.id, node] as const))
  const fixedNodeIds = new Set<string>()
  const nextNodes: ProjectCanvasFlowNode[] = []
  let latestNewNodeId: string | null = null

  for (const artifact of supportedArtifacts) {
    const nextNodeId = createArtifactNodeId(projectId, artifact.kind, artifact.artifactId)
    const existingNode = existingNodesById.get(nextNodeId)
    const storedPosition = storedPositionMap.get(nextNodeId)
    const canCreateStoredNode = storedPosition?.layoutMode === 'manual'

    if (!existingNode && !canCreateStoredNode && !placementBounds) {
      continue
    }

    if (
      existingNode?.data.layoutMode === 'manual' ||
      canCreateStoredNode ||
      (shouldPreserveExistingAutoNodePositions && existingNode)
    ) {
      fixedNodeIds.add(nextNodeId)
    }

    const nextNode = createCanvasNodeFromArtifact({
      artifact,
      generatedVideo,
      layoutMode: existingNode?.data.layoutMode ?? storedPosition?.layoutMode ?? 'auto',
      position: existingNode?.position ?? {
        x: storedPosition?.x ?? placementBounds?.minX ?? DEFAULT_PLACEMENT_BOUNDS.minX,
        y: storedPosition?.y ?? placementBounds?.minY ?? DEFAULT_PLACEMENT_BOUNDS.minY,
      },
      projectId,
    })

    if (!nextNode) {
      continue
    }

    nextNodes.push(nextNode)

    if (!existingNode && !storedPosition) {
      latestNewNodeId = nextNodeId
    }
  }

  const layoutNodes = resolveProjectCanvasNodesLayout({
    fixedNodeIds,
    nodes: nextNodes,
    placementBounds,
  })
  const nextSelectedNodeId =
    latestNewNodeId ??
    (state.selectedNodeId && layoutNodes.some((node) => node.id === state.selectedNodeId)
      ? state.selectedNodeId
      : (layoutNodes.at(-1)?.id ?? null))
  const highlightTargetNodeId = latestNewNodeId
  const highlightedNodeIds =
    highlightTargetNodeId !== null
      ? [highlightTargetNodeId]
      : state.highlightedNodeIds.filter((nodeId) => layoutNodes.some((node) => node.id === nodeId))
  const highlightToken =
    highlightTargetNodeId !== null ? state.highlightToken + 1 : state.highlightToken
  const decoratedNodes = decorateNodes({
    highlightedNodeIds,
    highlightToken,
    nodes: layoutNodes,
    selectedNodeId: nextSelectedNodeId,
  })

  return {
    focusNodeId: latestNewNodeId,
    highlightedNodeIds,
    highlightToken,
    nodes: decoratedNodes,
    selectedNodeId: nextSelectedNodeId,
    selectedNodeSummary: buildSelectedNodeSummary(decoratedNodes, nextSelectedNodeId),
    zoomLevel: decoratedNodes.length === 0 ? DEFAULT_CANVAS_ZOOM_LEVEL : state.zoomLevel,
  }
}

/**
 * 等待 React Flow 完成节点挂载后再执行视口聚焦。
 *
 * @param getState - Zustand store 的当前状态读取函数。
 * @param nodeId - 需要进入视口的节点 id。
 */
export const scheduleViewportFocusOnNode = (getState: () => ProjectCanvasState, nodeId: string) => {
  const focusNode = () => {
    const viewportController = getState().viewportController

    if (!viewportController) {
      return
    }

    viewportController.zoomToSelection(nodeId)
  }

  if (typeof window === 'undefined') {
    focusNode()
    return
  }

  if (typeof window.requestAnimationFrame === 'function') {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(focusNode)
    })
    return
  }

  window.setTimeout(focusNode, 0)
}
