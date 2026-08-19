import { forceSimulation, forceX, forceY } from 'd3-force'
import {
  ANCHOR_FORCE_STRENGTH,
  candidateCollides,
  createRectCollideForce,
  createSimulationNode,
  DEFAULT_COLUMN_WIDTH,
  DEFAULT_LAYOUT_GAP,
  DEFAULT_SIMULATION_TICKS,
  type LayoutRect,
  type LayoutSimulationNode,
  roundPosition,
  type RowOrderSlotCandidate,
  settleRectangles,
} from './project-canvas-layout-geometry'

export type ProjectCanvasLayoutMode = 'auto' | 'manual'

export interface ProjectCanvasMasonryBounds {
  maxX: number
  minX: number
  minY: number
}

export interface ProjectCanvasMasonryNode {
  height: number
  id: string
  layoutMode: ProjectCanvasLayoutMode
  width: number
  x: number
  y: number
}

export interface ProjectCanvasMasonryPosition {
  id: string
  layoutMode: ProjectCanvasLayoutMode
  x: number
  y: number
}

export interface ResolveProjectCanvasMasonryLayoutOptions {
  bounds: ProjectCanvasMasonryBounds
  columnWidth?: number
  gap?: number
  nodes: ProjectCanvasMasonryNode[]
}

export interface ResolveProjectCanvasCollisionLayoutOptions {
  fixedNodeIds?: string[]
  gap?: number
  maxTicks?: number
  nodes: ProjectCanvasMasonryNode[]
}

/**
 * 归一化正数布局参数。
 *
 * @param value - 调用方传入的候选数值。
 * @param fallback - 候选数值不可用时的默认值。
 * @returns 可安全用于布局计算的正数。
 */
const normalizePositiveNumber = (value: number | undefined, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback

/**
 * 计算节点需要覆盖的列数量。
 *
 * @param node - 参与布局的画布矩形节点。
 * @param columnWidth - 固定布局列宽。
 * @returns 至少为 1 的跨列数量。
 */
const getNodeColumnSpan = (node: ProjectCanvasMasonryNode, columnWidth: number) =>
  Math.max(1, Math.ceil(node.width / columnWidth))

/**
 * 计算指定列索引对应的横向锚点。
 *
 * @param params - 列锚点计算参数。
 * @param params.bounds - 当前画布可放置范围。
 * @param params.columnIndex - 从 0 开始的列索引。
 * @param params.columnWidth - 固定布局列宽。
 * @param params.gap - 节点之间保留的最小间距。
 * @returns 该列左上角对应的画布 x 坐标。
 */
const getColumnX = ({
  bounds,
  columnIndex,
  columnWidth,
  gap,
}: {
  bounds: ProjectCanvasMasonryBounds
  columnIndex: number
  columnWidth: number
  gap: number
}) => bounds.minX + columnIndex * (columnWidth + gap)

/**
 * 解析节点可尝试的起始列索引。
 *
 * @param params - 候选列计算参数。
 * @param params.bounds - 当前画布可放置范围。
 * @param params.columnWidth - 固定布局列宽。
 * @param params.gap - 节点之间保留的最小间距。
 * @param params.node - 需要排布的节点。
 * @returns 按从左到右排序的候选起始列索引；前两列不受屏幕宽度限制。
 */
const resolveCandidateColumnIndexes = ({
  bounds,
  columnWidth,
  gap,
  node,
}: {
  bounds: ProjectCanvasMasonryBounds
  columnWidth: number
  gap: number
  node: ProjectCanvasMasonryNode
}) => {
  const columnIndexes = [0, 1]
  let nextColumnIndex = 2

  while (
    getColumnX({
      bounds,
      columnIndex: nextColumnIndex,
      columnWidth,
      gap,
    }) +
      node.width <=
    bounds.maxX
  ) {
    columnIndexes.push(nextColumnIndex)
    nextColumnIndex += 1
  }

  return columnIndexes
}

/**
 * 计算行序布局使用的固定行高。
 *
 * @param nodes - 当前参与布局的节点集合。
 * @param fallback - 节点集合为空或高度非法时的行高。
 * @returns 节点最大高度，保证不等高输入也不会行间重叠。
 */
const resolveRowHeight = (nodes: ProjectCanvasMasonryNode[], fallback: number) => {
  let rowHeight = fallback

  for (const node of nodes) {
    if (Number.isFinite(node.height) && node.height > 0) {
      rowHeight = Math.max(rowHeight, node.height)
    }
  }

  return rowHeight
}

/**
 * 创建用于碰撞检测的布局矩形。
 *
 * @param node - 参与布局的画布节点。
 * @returns 与节点当前位置一致的布局矩形。
 */
const createLayoutRect = (node: ProjectCanvasMasonryNode): LayoutRect => ({
  height: node.height,
  id: node.id,
  layoutMode: node.layoutMode,
  width: node.width,
  x: node.x,
  y: node.y,
})

/**
 * 将行序 slot 转换成画布坐标。
 *
 * @param params - slot 解析参数。
 * @param params.bounds - 当前画布可放置范围。
 * @param params.candidateColumnIndexes - 当前节点可使用的列索引。
 * @param params.columnWidth - 固定布局列宽。
 * @param params.gap - 节点之间保留的最小间距。
 * @param params.rowHeight - 固定行高。
 * @param params.slotIndex - 从 0 开始的行序 slot。
 * @param params.span - 当前节点覆盖的列数量。
 * @returns 可放置时返回坐标；slot 会让节点跨出当前行时返回 null。
 */
const resolveRowOrderSlotCandidate = ({
  bounds,
  candidateColumnIndexes,
  columnWidth,
  gap,
  rowHeight,
  slotIndex,
  span,
}: {
  bounds: ProjectCanvasMasonryBounds
  candidateColumnIndexes: number[]
  columnWidth: number
  gap: number
  rowHeight: number
  slotIndex: number
  span: number
}): RowOrderSlotCandidate | null => {
  const columnCount = candidateColumnIndexes.length
  const rowIndex = Math.floor(slotIndex / columnCount)
  const columnOffset = slotIndex % columnCount

  if (columnOffset + span > columnCount) {
    return null
  }

  const columnIndex = candidateColumnIndexes[columnOffset] ?? 0

  return {
    slotIndex,
    x: getColumnX({
      bounds,
      columnIndex,
      columnWidth,
      gap,
    }),
    y: bounds.minY + rowIndex * (rowHeight + gap),
  }
}

/**
 * 在行序布局中解析单个自动节点的位置。
 *
 * @param params - 自动节点位置解析参数。
 * @param params.bounds - 当前画布可放置范围。
 * @param params.columnWidth - 固定布局列宽。
 * @param params.gap - 节点之间保留的最小间距。
 * @param params.node - 需要自动排布的节点。
 * @param params.placedRects - 已经进入布局的矩形。
 * @param params.rowHeight - 固定行高。
 * @param params.startSlotIndex - 当前自动布局游标位置。
 * @returns 第一个不碰撞的从左到右、从上到下候选位置。
 */
const resolveAutoNodePosition = ({
  bounds,
  columnWidth,
  gap,
  node,
  placedRects,
  rowHeight,
  startSlotIndex,
}: {
  bounds: ProjectCanvasMasonryBounds
  columnWidth: number
  gap: number
  node: ProjectCanvasMasonryNode
  placedRects: LayoutRect[]
  rowHeight: number
  startSlotIndex: number
}) => {
  const candidateColumnIndexes = resolveCandidateColumnIndexes({
    bounds,
    columnWidth,
    gap,
    node,
  })
  const span = getNodeColumnSpan(node, columnWidth)
  let slotIndex = startSlotIndex
  const maxAttempts = Math.max(1000, (placedRects.length + 1) * candidateColumnIndexes.length * 16)

  for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex += 1) {
    const candidate = resolveRowOrderSlotCandidate({
      bounds,
      candidateColumnIndexes,
      columnWidth,
      gap,
      rowHeight,
      slotIndex,
      span,
    })

    slotIndex += 1

    if (!candidate) {
      continue
    }

    const candidateRect = {
      height: node.height,
      id: node.id,
      layoutMode: node.layoutMode,
      width: node.width,
      x: candidate.x,
      y: candidate.y,
    } satisfies LayoutRect

    if (!candidateCollides({ candidate: candidateRect, gap, placedRects })) {
      return {
        nextSlotIndex: candidate.slotIndex + span,
        x: candidate.x,
        y: candidate.y,
      }
    }
  }

  return {
    nextSlotIndex: slotIndex + span,
    x: bounds.minX,
    y: bounds.minY + slotIndex * (rowHeight + gap),
  }
}

/**
 * 解析项目画布从左到右、从上到下的行序自动布局。
 *
 * @param options - 布局节点、画布范围和列配置。
 * @returns 每个节点解析后的画布坐标与布局模式。
 */
export const resolveProjectCanvasMasonryLayout = ({
  bounds,
  columnWidth: rawColumnWidth,
  gap: rawGap,
  nodes,
}: ResolveProjectCanvasMasonryLayoutOptions): ProjectCanvasMasonryPosition[] => {
  const columnWidth = normalizePositiveNumber(rawColumnWidth, DEFAULT_COLUMN_WIDTH)
  const gap = normalizePositiveNumber(rawGap, DEFAULT_LAYOUT_GAP)
  const rowHeight = resolveRowHeight(nodes, columnWidth * (10 / 16))
  const placedRects: LayoutRect[] = []
  const positionMap = new Map<string, ProjectCanvasMasonryPosition>()
  let nextAutoSlotIndex = 0

  for (const node of nodes) {
    if (node.layoutMode !== 'manual') {
      continue
    }

    const rect = createLayoutRect(node)
    placedRects.push(rect)
    positionMap.set(node.id, {
      id: node.id,
      layoutMode: node.layoutMode,
      x: node.x,
      y: node.y,
    })
  }

  for (const node of nodes) {
    if (node.layoutMode !== 'auto') {
      continue
    }

    const position = resolveAutoNodePosition({
      bounds,
      columnWidth,
      gap,
      node,
      placedRects,
      rowHeight,
      startSlotIndex: nextAutoSlotIndex,
    })
    const rect = {
      height: node.height,
      id: node.id,
      layoutMode: node.layoutMode,
      width: node.width,
      x: position.x,
      y: position.y,
    } satisfies LayoutRect

    nextAutoSlotIndex = position.nextSlotIndex
    placedRects.push(rect)
    positionMap.set(node.id, {
      id: node.id,
      layoutMode: node.layoutMode,
      x: position.x,
      y: position.y,
    })
  }

  return nodes.map((node) => {
    const position = positionMap.get(node.id)

    if (position) {
      return position
    }

    return {
      id: node.id,
      layoutMode: node.layoutMode,
      x: node.x,
      y: node.y,
    }
  })
}

/**
 * 使用局部物理碰撞微调已有画布节点位置。
 *
 * 该函数用于用户拖拽后解决 manual/auto 碰撞：manual 节点固定，auto 节点以当前位置为锚点做小范围推开，
 * 避免重新进入行序 slot 导致节点整格跳走。
 *
 * @param options - 局部碰撞节点、固定节点和模拟配置。
 * @returns 每个节点微调后的画布坐标与布局模式。
 */
export const resolveProjectCanvasCollisionLayout = ({
  fixedNodeIds: rawFixedNodeIds,
  gap: rawGap,
  maxTicks: rawMaxTicks,
  nodes,
}: ResolveProjectCanvasCollisionLayoutOptions): ProjectCanvasMasonryPosition[] => {
  const gap = normalizePositiveNumber(rawGap, DEFAULT_LAYOUT_GAP)
  const maxTicks = Math.max(
    1,
    Math.floor(normalizePositiveNumber(rawMaxTicks, DEFAULT_SIMULATION_TICKS)),
  )
  const fixedNodeIds = new Set(rawFixedNodeIds ?? [])
  const simulationNodes = nodes.map((node) => createSimulationNode(node, fixedNodeIds))

  if (simulationNodes.length < 2) {
    return simulationNodes.map((node) => ({
      id: node.id,
      layoutMode: node.layoutMode,
      x: roundPosition(node.x),
      y: roundPosition(node.y),
    }))
  }

  const simulation = forceSimulation(simulationNodes)
    .alpha(1)
    .alphaMin(0.001)
    .velocityDecay(0.35)
    .force(
      'anchor-x',
      forceX<LayoutSimulationNode>((node) => node.anchorX).strength(ANCHOR_FORCE_STRENGTH),
    )
    .force(
      'anchor-y',
      forceY<LayoutSimulationNode>((node) => node.anchorY).strength(ANCHOR_FORCE_STRENGTH),
    )
    .force('rect-collide', createRectCollideForce(gap))

  simulation.stop()

  for (let tickIndex = 0; tickIndex < maxTicks; tickIndex += 1) {
    simulation.tick()
  }

  settleRectangles(simulationNodes, gap)
  simulation.stop()

  return simulationNodes.map((node) => ({
    id: node.id,
    layoutMode: node.layoutMode,
    x: roundPosition(node.x),
    y: roundPosition(node.y),
  }))
}
