import type {
  ProjectCanvasFlowNode,
  ProjectCanvasNodeSummary,
} from '@/features/project-canvas/components/nodes/project-canvas-node.types'
import {
  type ProjectCanvasLayoutMode,
  resolveProjectCanvasCollisionLayout,
  resolveProjectCanvasMasonryLayout,
} from '@/features/project-canvas/layout/project-canvas-masonry-layout.utils'
import {
  NEW_NODE_GAP,
  PROJECT_CANVAS_STANDARD_NODE_SIZE,
  type ProjectCanvasPositionedNode,
  type ProjectCanvasPlacementBounds,
  ZOOM_MAX,
  ZOOM_MIN,
} from './project-canvas-store.types'

/**
 * 将缩放等级限制在画布允许范围内。
 *
 * @param level - 用户或视口同步得到的缩放百分比。
 * @returns 被限制在最小和最大缩放之间的缩放百分比。
 */
export const assertFiniteZoomLevel = (level: number, source: string) => {
  if (!Number.isFinite(level)) {
    throw new Error(
      `Project canvas zoom level must be finite in ${source}; received ${String(level)}.`,
    )
  }
}

export const clampZoom = (level: number) => {
  assertFiniteZoomLevel(level, 'clampZoom')

  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, level))
}

export const resolveZoomLevelFromViewportZoom = (zoom: number) => {
  if (!Number.isFinite(zoom) || zoom <= 0) {
    throw new Error(
      `Project canvas viewport zoom must be a finite positive number; received ${String(zoom)}.`,
    )
  }

  return clampZoom(Math.round(zoom * 100))
}

/**
 * 判断指定画布节点类型是否支持导出。
 *
 * @param kind - 画布节点的业务类型。
 * @returns 节点支持导出时返回 true。
 */
export const isExportableArtifactKind = (kind: ProjectCanvasNodeSummary['kind']) =>
  kind === 'brief' ||
  kind === 'storyboard' ||
  kind === 'ui-card' ||
  kind === 'markdown' ||
  kind === 'image-analysis-summary'

/**
 * 给节点补齐当前高亮和选中派生状态。
 *
 * @param params - 节点装饰所需的高亮、选中和源节点信息。
 * @param params.highlightToken - 当前高亮批次标记。
 * @param params.isHighlighted - 当前节点是否处于高亮状态。
 * @param params.node - 需要装饰的原始画布节点。
 * @param params.selectedNodeId - 当前选中的节点 id。
 * @returns 保留原判别类型并写入 UI 派生状态的节点。
 */
export const decorateNode = <T extends ProjectCanvasFlowNode>({
  highlightToken,
  isHighlighted,
  node,
  selectedNodeId,
}: {
  highlightToken: number
  isHighlighted: boolean
  node: T
  selectedNodeId: string | null
}): T => ({
  ...node,
  data: {
    ...node.data,
    highlightToken,
    isHighlighted,
  },
  selected: node.id === selectedNodeId,
})

/**
 * 根据当前选中节点生成侧栏摘要。
 *
 * @param nodes - 当前画布节点列表。
 * @param selectedNodeId - 当前选中的节点 id。
 * @returns 选中节点的精简摘要；未选中或节点不存在时返回 null。
 */
export const buildSelectedNodeSummary = (
  nodes: ProjectCanvasFlowNode[],
  selectedNodeId: string | null,
): ProjectCanvasNodeSummary | null => {
  if (!selectedNodeId) {
    return null
  }

  const selectedNode = nodes.find((node) => node.id === selectedNodeId)

  if (!selectedNode) {
    return null
  }

  return {
    exportable: isExportableArtifactKind(selectedNode.data.artifactKind),
    id: selectedNode.id,
    kind: selectedNode.data.artifactKind,
    title: selectedNode.data.title,
  }
}

/**
 * 批量给画布节点补齐高亮和选中派生状态。
 *
 * @param params - 批量装饰所需的节点和 UI 状态。
 * @param params.highlightedNodeIds - 当前高亮节点 id 列表。
 * @param params.highlightToken - 当前高亮批次标记。
 * @param params.nodes - 需要装饰的画布节点列表。
 * @param params.selectedNodeId - 当前选中的节点 id。
 * @returns 写入派生 UI 状态后的节点列表。
 */
export const decorateNodes = ({
  highlightedNodeIds,
  highlightToken,
  nodes,
  selectedNodeId,
}: {
  highlightedNodeIds: string[]
  highlightToken: number
  nodes: ProjectCanvasFlowNode[]
  selectedNodeId: string | null
}) =>
  nodes.map((node) =>
    decorateNode({
      highlightToken,
      isHighlighted: highlightedNodeIds.includes(node.id),
      node,
      selectedNodeId,
    }),
  )

/**
 * 获取节点参与布局时使用的宽度。
 *
 * @param node - 当前画布节点。
 * @returns 优先使用节点样式宽度，缺失时回退到默认卡片宽度。
 */
export const getNodeWidth = (node: ProjectCanvasPositionedNode) => {
  const width = node.style?.width

  return typeof width === 'number' && Number.isFinite(width)
    ? width
    : PROJECT_CANVAS_STANDARD_NODE_SIZE.width
}

export const DEFAULT_PLACEMENT_BOUNDS: ProjectCanvasPlacementBounds = {
  maxX: 0,
  minX: 0,
  minY: 0,
}

/**
 * 获取节点参与自动布局时使用的高度。
 *
 * @param node - 当前画布节点。
 * @returns 优先使用固定节点样式高度，缺失时使用 React Flow 实测高度或统一默认高度。
 */
export const getNodeHeight = (node: ProjectCanvasPositionedNode) => {
  const styleHeight = node.style?.height

  if (typeof styleHeight === 'number' && Number.isFinite(styleHeight) && styleHeight > 0) {
    return styleHeight
  }

  const height = node.measured?.height ?? node.height

  return typeof height === 'number' && Number.isFinite(height) && height > 0
    ? height
    : PROJECT_CANVAS_STANDARD_NODE_SIZE.height
}

/**
 * 判断两个可 JSON 序列化的画布快照是否等价。
 *
 * @param left - 当前 store 中保存的快照。
 * @param right - 新同步进来的快照。
 * @returns 两个快照序列化结果一致时返回 true。
 */
export const areJsonSerializableValuesEqual = (left: unknown, right: unknown) => {
  if (Object.is(left, right)) {
    return true
  }

  try {
    return JSON.stringify(left) === JSON.stringify(right)
  } catch {
    return false
  }
}

/**
 * 在新旧快照等价时复用当前引用。
 *
 * @param current - 当前 store state 中的值。
 * @param next - 新同步进来的值。
 * @returns 等价时返回 current，否则返回 next。
 */
export const preserveEqualSerializableValue = <T>(current: T, next: T) =>
  areJsonSerializableValuesEqual(current, next) ? current : next

/**
 * 判断两个画布节点矩形在给定间距下是否碰撞。
 *
 * @param left - 第一个画布节点。
 * @param right - 第二个画布节点。
 * @param gap - 节点之间需要保留的最小间距。
 * @returns 两个节点间距不足时返回 true。
 */
export const canvasNodesOverlap = (
  left: ProjectCanvasPositionedNode,
  right: ProjectCanvasPositionedNode,
  gap = NEW_NODE_GAP,
) =>
  left.position.x < right.position.x + getNodeWidth(right) + gap &&
  left.position.x + getNodeWidth(left) + gap > right.position.x &&
  left.position.y < right.position.y + getNodeHeight(right) + gap &&
  left.position.y + getNodeHeight(left) + gap > right.position.y

/**
 * 判断当前节点集合中是否存在 manual/manual 碰撞。
 *
 * @param nodes - 已经写入候选坐标和布局模式的画布节点。
 * @returns 任意两个手动节点碰撞时返回 true。
 */
export const hasManualNodeCollision = (nodes: ProjectCanvasPositionedNode[]) => {
  const manualNodes = nodes.filter((node) => node.data.layoutMode === 'manual')

  for (const [leftIndex, leftNode] of manualNodes.entries()) {
    for (const rightNode of manualNodes.slice(leftIndex + 1)) {
      if (canvasNodesOverlap(leftNode, rightNode)) {
        return true
      }
    }
  }

  return false
}

/**
 * 在保留具体节点判别类型的前提下更新坐标和布局模式。
 *
 * @param params - 节点布局状态更新参数。
 * @param params.layoutMode - 节点新的布局模式。
 * @param params.node - 需要更新的画布节点。
 * @param params.position - 节点新的画布坐标。
 * @returns 保留原节点类型的更新结果。
 */
export const updateProjectCanvasNodeLayout = <T extends ProjectCanvasPositionedNode>({
  layoutMode,
  node,
  position,
}: {
  layoutMode: ProjectCanvasLayoutMode
  node: T
  position: { x: number; y: number }
}): T => ({
  ...node,
  data: {
    ...node.data,
    layoutMode,
  },
  position,
})

/**
 * 对完整画布节点列表执行行序体积碰撞重排。
 *
 * @param params - 重排所需的节点和可放置范围。
 * @param params.fixedNodeIds - 本次增量同步中需要保留现有坐标的节点 id。
 * @param params.nodes - 已经创建完整 data 和尺寸信息的画布节点。
 * @param params.placementBounds - 当前视窗推导出的可放置画布范围。
 * @returns 带有最新坐标和 layoutMode 的画布节点列表。
 */
export const resolveProjectCanvasNodesLayout = ({
  fixedNodeIds = new Set<string>(),
  nodes,
  placementBounds,
}: {
  fixedNodeIds?: ReadonlySet<string>
  nodes: ProjectCanvasFlowNode[]
  placementBounds: ProjectCanvasPlacementBounds | null
}) => {
  const bounds = placementBounds ?? DEFAULT_PLACEMENT_BOUNDS
  const positions = resolveProjectCanvasMasonryLayout({
    bounds,
    columnWidth: PROJECT_CANVAS_STANDARD_NODE_SIZE.width,
    gap: NEW_NODE_GAP,
    nodes: nodes.map((node) => ({
      height: getNodeHeight(node),
      id: node.id,
      layoutMode: fixedNodeIds.has(node.id) ? 'manual' : node.data.layoutMode,
      width: getNodeWidth(node),
      x: node.position.x,
      y: node.position.y,
    })),
  })
  const positionMap = new Map(positions.map((position) => [position.id, position] as const))

  return nodes.map((node) => {
    const position = positionMap.get(node.id)

    if (!position) {
      return node
    }

    return updateProjectCanvasNodeLayout({
      layoutMode: node.data.layoutMode,
      node,
      position: {
        x: position.x,
        y: position.y,
      },
    })
  })
}

/**
 * 对已有画布节点执行拖拽后的局部物理碰撞微调。
 *
 * @param nodes - 已经写入候选坐标和布局模式的画布节点。
 * @returns manual 节点固定、auto 节点微调后的画布节点列表。
 */
export const resolveProjectCanvasNodesCollisionLayout = <T extends ProjectCanvasPositionedNode>(
  nodes: T[],
): T[] => {
  const fixedNodeIds = nodes
    .filter((node) => node.data.layoutMode === 'manual')
    .map((node) => node.id)
  const positions = resolveProjectCanvasCollisionLayout({
    fixedNodeIds,
    gap: NEW_NODE_GAP,
    nodes: nodes.map((node) => ({
      height: getNodeHeight(node),
      id: node.id,
      layoutMode: node.data.layoutMode,
      width: getNodeWidth(node),
      x: node.position.x,
      y: node.position.y,
    })),
  })
  const positionMap = new Map(positions.map((position) => [position.id, position] as const))

  return nodes.map((node) => {
    const position = positionMap.get(node.id)

    if (!position) {
      return node
    }

    return updateProjectCanvasNodeLayout({
      layoutMode: position.layoutMode,
      node,
      position: {
        x: position.x,
        y: position.y,
      },
    })
  })
}
