import type {
  ProjectCanvasLayoutMode,
  ProjectCanvasMasonryNode,
} from './project-canvas-masonry-layout.utils'

export interface LayoutRect {
  fixed?: boolean
  height: number
  id: string
  layoutMode: ProjectCanvasLayoutMode
  width: number
  x: number
  y: number
}

export interface LayoutRectBounds {
  bottom: number
  left: number
  right: number
  top: number
}

export interface RectOverlap {
  x: number
  y: number
}

export interface RowOrderSlotCandidate {
  slotIndex: number
  x: number
  y: number
}

export interface LayoutSimulationNode extends LayoutRect {
  anchorX: number
  anchorY: number
  fixed?: boolean
  fx?: number | null
  fy?: number | null
  index?: number
  vx?: number
  vy?: number
}

export const DEFAULT_COLUMN_WIDTH = 1584
export const DEFAULT_LAYOUT_GAP = 20
export const DEFAULT_SIMULATION_TICKS = 80
export const MAX_SETTLE_PASSES = 24
export const OVERLAP_EPSILON = 0.001
export const POSITION_PRECISION = 100
export const ANCHOR_FORCE_STRENGTH = 0.08

/**
 * 获取带碰撞间距扩张的矩形边界。
 *
 * 历史画布碰撞算法会把两个矩形各自向外扩张 `gap / 2`，这样两者的相交区域就等价于节点之间的最小留白。
 *
 * @param rect - 参与碰撞检测的布局矩形。
 * @param gap - 节点之间保留的最小间距。
 * @returns 扩张后的矩形边界。
 */
export const getExpandedRectBounds = (rect: LayoutRect, gap: number): LayoutRectBounds => {
  const padding = gap / 2

  return {
    bottom: rect.y + rect.height + padding,
    left: rect.x - padding,
    right: rect.x + rect.width + padding,
    top: rect.y - padding,
  }
}

/**
 * 计算两个矩形在扩张边界后的体积重叠量。
 *
 * @param left - 第一个布局矩形。
 * @param right - 第二个布局矩形。
 * @param gap - 节点之间保留的最小间距。
 * @returns 存在有效重叠时返回两轴重叠量，否则返回 null。
 */
export const getRectOverlap = (
  left: LayoutRect,
  right: LayoutRect,
  gap: number,
): RectOverlap | null => {
  const leftBounds = getExpandedRectBounds(left, gap)
  const rightBounds = getExpandedRectBounds(right, gap)
  const overlapX =
    Math.min(leftBounds.right, rightBounds.right) - Math.max(leftBounds.left, rightBounds.left)
  const overlapY =
    Math.min(leftBounds.bottom, rightBounds.bottom) - Math.max(leftBounds.top, rightBounds.top)

  if (overlapX <= OVERLAP_EPSILON || overlapY <= OVERLAP_EPSILON) {
    return null
  }

  return {
    x: overlapX,
    y: overlapY,
  }
}

/**
 * 判断两个矩形是否在给定间距下发生体积碰撞。
 *
 * @param left - 第一个布局矩形。
 * @param right - 第二个布局矩形。
 * @param gap - 节点之间保留的最小间距。
 * @returns 两个矩形的间距不足时返回 true。
 */
export const rectanglesCollide = (left: LayoutRect, right: LayoutRect, gap: number) =>
  getRectOverlap(left, right, gap) !== null

/**
 * 将模拟后的位置规整到稳定小数位。
 *
 * @param value - 待规整的坐标值。
 * @returns 保留固定精度后的坐标。
 */
export const roundPosition = (value: number) =>
  Math.round(value * POSITION_PRECISION) / POSITION_PRECISION

/**
 * 计算矩形中心点横坐标。
 *
 * @param rect - 参与碰撞计算的矩形。
 * @returns 矩形中心点 x 坐标。
 */
export const getCenterX = (rect: LayoutRect) => rect.x + rect.width / 2

/**
 * 计算矩形中心点纵坐标。
 *
 * @param rect - 参与碰撞计算的矩形。
 * @returns 矩形中心点 y 坐标。
 */
export const getCenterY = (rect: LayoutRect) => rect.y + rect.height / 2

/**
 * 解析两个中心点重合时使用的备用推开方向。
 *
 * @param delta - 两个中心点在当前轴上的差值。
 * @param fallback - 差值为 0 时使用的备用方向。
 * @returns 当前轴的移动方向。
 */
export const createAxisDirection = (delta: number, fallback: number) => {
  if (delta === 0) {
    return fallback
  }

  return Math.sign(delta)
}

/**
 * 沿指定轴拆分两个矩形的重叠体积。
 *
 * @param params - 轴向拆分参数。
 * @param params.amount - 当前轴需要拆开的重叠距离。
 * @param params.axis - 需要移动的坐标轴。
 * @param params.fallbackDirection - 中心点重合时使用的备用方向。
 * @param params.left - 第一个碰撞矩形。
 * @param params.right - 第二个碰撞矩形。
 * @returns 至少一个矩形被移动时返回 true。
 */
export const applyAxisSeparation = ({
  amount,
  axis,
  fallbackDirection,
  left,
  right,
}: {
  amount: number
  axis: 'x' | 'y'
  fallbackDirection: number
  left: LayoutRect
  right: LayoutRect
}) => {
  const leftFixed = left.fixed === true || left.layoutMode === 'manual'
  const rightFixed = right.fixed === true || right.layoutMode === 'manual'

  if (leftFixed && rightFixed) {
    return false
  }

  const delta =
    axis === 'x' ? getCenterX(right) - getCenterX(left) : getCenterY(right) - getCenterY(left)
  const direction = createAxisDirection(delta, fallbackDirection)

  if (leftFixed) {
    if (axis === 'x') {
      right.x += amount * direction
    } else {
      right.y += amount * direction
    }

    return true
  }

  if (rightFixed) {
    if (axis === 'x') {
      left.x -= amount * direction
    } else {
      left.y -= amount * direction
    }

    return true
  }

  const halfAmount = amount / 2

  if (axis === 'x') {
    left.x -= halfAmount * direction
    right.x += halfAmount * direction
  } else {
    left.y -= halfAmount * direction
    right.y += halfAmount * direction
  }

  return true
}

/**
 * 解决一对矩形之间的残余碰撞。
 *
 * @param params - 单对碰撞解决参数。
 * @param params.left - 第一个碰撞矩形。
 * @param params.minGap - 节点之间保留的最小间距。
 * @param params.pairIndex - 当前碰撞对序号，用于生成稳定备用方向。
 * @param params.right - 第二个碰撞矩形。
 * @returns 当前碰撞对被拆开时返回 true。
 */
export const resolveNodePairOverlap = ({
  left,
  minGap,
  pairIndex,
  right,
}: {
  left: LayoutRect
  minGap: number
  pairIndex: number
  right: LayoutRect
}) => {
  const overlap = getRectOverlap(left, right, minGap)

  if (!overlap) {
    return false
  }

  const fallbackDirection = pairIndex % 2 === 0 ? -1 : 1
  const moveAlongX = overlap.x < overlap.y

  return applyAxisSeparation({
    amount: moveAlongX ? overlap.x : overlap.y,
    axis: moveAlongX ? 'x' : 'y',
    fallbackDirection,
    left,
    right,
  })
}

/**
 * 通过多轮确定性拆分清理模拟后的残余碰撞。
 *
 * @param nodes - 参与碰撞解决的矩形节点。
 * @param minGap - 节点之间保留的最小间距。
 */
export const settleRectangles = (nodes: LayoutRect[], minGap: number) => {
  const sortedNodes = [...nodes].sort((left, right) => left.id.localeCompare(right.id))

  for (let passIndex = 0; passIndex < MAX_SETTLE_PASSES; passIndex += 1) {
    let hasChanges = false

    for (const [leftIndex, leftNode] of sortedNodes.entries()) {
      for (const [offset, rightNode] of sortedNodes.slice(leftIndex + 1).entries()) {
        const didResolveOverlap = resolveNodePairOverlap({
          left: leftNode,
          minGap,
          pairIndex: leftIndex + offset,
          right: rightNode,
        })

        if (didResolveOverlap) {
          hasChanges = true
        }
      }
    }

    if (!hasChanges) {
      break
    }
  }
}

/**
 * 创建矩形体积碰撞 force。
 *
 * @param minGap - 节点之间保留的最小间距。
 * @returns 可交给 d3-force simulation 的矩形碰撞力。
 */
export const createRectCollideForce = (minGap: number) => {
  let nodes: LayoutSimulationNode[] = []

  const force = (alpha: number) => {
    for (const [leftIndex, leftNode] of nodes.entries()) {
      for (const [offset, rightNode] of nodes.slice(leftIndex + 1).entries()) {
        const overlap = getRectOverlap(leftNode, rightNode, minGap)

        if (!overlap) {
          continue
        }

        const scale = Math.max(alpha, 0.2)
        const moveAlongX = overlap.x < overlap.y

        applyAxisSeparation({
          amount: (moveAlongX ? overlap.x : overlap.y) * scale,
          axis: moveAlongX ? 'x' : 'y',
          fallbackDirection: (leftIndex + offset) % 2 === 0 ? -1 : 1,
          left: leftNode,
          right: rightNode,
        })
      }
    }
  }

  force.initialize = (nextNodes: LayoutSimulationNode[]) => {
    nodes = nextNodes
  }

  return force
}

/**
 * 创建参与局部物理碰撞的模拟节点。
 *
 * @param node - 原始画布布局节点。
 * @param fixedNodeIds - 必须保持坐标不变的节点 id 集合。
 * @returns 可交给 d3-force 使用的模拟节点。
 */
export const createSimulationNode = (
  node: ProjectCanvasMasonryNode,
  fixedNodeIds: Set<string>,
): LayoutSimulationNode => {
  const isFixed = fixedNodeIds.has(node.id) || node.layoutMode === 'manual'

  return {
    anchorX: node.x,
    anchorY: node.y,
    fixed: isFixed,
    fx: isFixed ? node.x : null,
    fy: isFixed ? node.y : null,
    height: node.height,
    id: node.id,
    layoutMode: node.layoutMode,
    width: node.width,
    x: node.x,
    y: node.y,
  }
}

/**
 * 判断候选矩形是否与已放置矩形碰撞。
 *
 * @param params - 碰撞检测参数。
 * @param params.candidate - 当前候选矩形。
 * @param params.gap - 节点之间保留的最小间距。
 * @param params.placedRects - 已放置或用户手动挪动过的矩形。
 * @returns 存在碰撞时返回 true。
 */
export const candidateCollides = ({
  candidate,
  gap,
  placedRects,
}: {
  candidate: LayoutRect
  gap: number
  placedRects: LayoutRect[]
}) => {
  for (const placedRect of placedRects) {
    if (rectanglesCollide(candidate, placedRect, gap)) {
      return true
    }
  }

  return false
}
