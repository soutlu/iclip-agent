import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  type Node,
  type NodeChange,
  type NodeTypes,
  PanOnScrollMode,
  ReactFlow,
  type ReactFlowInstance,
  ReactFlowProvider,
} from '@xyflow/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import BriefCanvasNode from '@/features/project-canvas/components/nodes/BriefCanvasNode'
import ImageAnalysisSummaryCanvasNode from '@/features/project-canvas/components/nodes/ImageAnalysisSummaryCanvasNode'
import MarkdownCanvasNode from '@/features/project-canvas/components/nodes/MarkdownCanvasNode'
import type { ProjectCanvasFlowNode } from '@/features/project-canvas/components/nodes/project-canvas-node.types'
import StoryboardCanvasNode from '@/features/project-canvas/components/nodes/StoryboardCanvasNode'
import UiCardCanvasNode from '@/features/project-canvas/components/nodes/UiCardCanvasNode'
import VideoPromptCanvasNode from '@/features/project-canvas/components/nodes/VideoPromptCanvasNode'
import ProjectCanvasGlow from '@/features/project-canvas/components/ProjectCanvasGlow'
import {
  DEFAULT_CANVAS_ZOOM_LEVEL,
  type ProjectCanvasPlacementBounds,
  type ProjectCanvasWorkspaceNode,
  useProjectCanvasStore,
} from '@/features/project-canvas/state/project-canvas-store'

const EMPTY_EDGES: never[] = []
const EMPTY_PROJECT_NODES: ProjectCanvasFlowNode[] = []
const VIEWPORT_ANIMATION_DURATION = 180
const ZOOM_IN_FACTOR = 1.2
const ZOOM_MAX = 4
const ZOOM_MIN = 0.1
const FLOW_BACKGROUND_DOT_SIZE = 2
const FIT_VIEW_PADDING = 0.18
const PLACEMENT_GAP = 28
const PLACEMENT_RIGHT_GUTTER = 96
const PLACEMENT_TOP = 168
const ZOOM_BUCKET_HYSTERESIS = 0.1
const ZOOM_BUCKETS = [
  { gapMultiplier: 64, maxZoom: 0.023 },
  { gapMultiplier: 16, maxZoom: 0.094 },
  { gapMultiplier: 4, maxZoom: 0.375 },
  { gapMultiplier: 1, maxZoom: Number.POSITIVE_INFINITY },
] as const
const PROJECT_CANVAS_NODE_TYPES = {
  'brief-node': BriefCanvasNode,
  'image-analysis-summary-node': ImageAnalysisSummaryCanvasNode,
  'markdown-node': MarkdownCanvasNode,
  'storyboard-node': StoryboardCanvasNode,
  'ui-card-node': UiCardCanvasNode,
  'video-prompt-node': VideoPromptCanvasNode,
} satisfies NodeTypes

export type CanvasViewportExtraNode = Node<Record<string, unknown>, string>

interface CanvasViewportProps {
  enableViewportZoom?: boolean
  extraNodeTypes?: NodeTypes
  extraNodes?: CanvasViewportExtraNode[]
  showProjectNodes?: boolean
}

interface CanvasViewportContentProps {
  enableViewportZoom: boolean
  extraNodeTypes?: NodeTypes
  extraNodes: CanvasViewportExtraNode[]
  showProjectNodes: boolean
}

type CanvasViewportNode =
  ProjectCanvasFlowNode | ProjectCanvasWorkspaceNode | CanvasViewportExtraNode

/**
 * 将数值限制在指定区间内。
 *
 * @param value - 原始数值。
 * @param min - 允许的最小值。
 * @param max - 允许的最大值。
 * @returns 被限制在区间内的数值。
 */
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

const DEFAULT_CANVAS_ZOOM = DEFAULT_CANVAS_ZOOM_LEVEL / 100

const assertFiniteViewportZoom = (zoom: number, source: string) => {
  if (!Number.isFinite(zoom) || zoom <= 0) {
    throw new Error(
      `Project canvas viewport zoom must be finite and positive in ${source}; received ${String(zoom)}.`,
    )
  }
}

const resolveBackgroundZoom = (zoomLevel: number) => {
  if (!Number.isFinite(zoomLevel)) {
    throw new Error(
      `Project canvas zoom level must be finite for background rendering; received ${String(zoomLevel)}.`,
    )
  }

  return Math.max(zoomLevel / 100, ZOOM_MIN)
}

/**
 * 读取左侧输出面板占用的屏幕右边界。
 *
 * @param bounds - React Flow 容器视口边界。
 * @returns 节点可放置区域的屏幕左边界。
 */
const resolvePlacementScreenLeft = (bounds: DOMRect) => {
  const outputPanel = document.querySelector<HTMLElement>('[data-project-output-panel="true"]')
  const outputPanelRect = outputPanel?.getBoundingClientRect()

  if (!outputPanelRect || outputPanelRect.width <= 0 || outputPanelRect.height <= 0) {
    return PLACEMENT_GAP
  }

  return Math.max(PLACEMENT_GAP, outputPanelRect.right - bounds.left + PLACEMENT_GAP)
}

/**
 * 根据当前 React Flow 视口计算新节点可使用的画布坐标范围。
 *
 * @param params - 当前容器尺寸和 React Flow viewport。
 * @param params.bounds - React Flow 容器视口边界。
 * @param params.viewport - 当前 React Flow viewport。
 * @returns 新节点放置时可使用的画布范围。
 */
const resolvePlacementBounds = ({
  bounds,
  viewport,
}: {
  bounds: DOMRect
  viewport: { x: number; y: number; zoom: number }
}): ProjectCanvasPlacementBounds => {
  assertFiniteViewportZoom(viewport.zoom, 'placement bounds')

  const zoom = Math.max(viewport.zoom, ZOOM_MIN)
  const screenLeft = resolvePlacementScreenLeft(bounds)
  const screenRight = Math.max(screenLeft, bounds.width - PLACEMENT_RIGHT_GUTTER)

  return {
    maxX: Math.round((screenRight - viewport.x) / zoom),
    minX: Math.round((screenLeft - viewport.x) / zoom),
    minY: Math.round((PLACEMENT_TOP - viewport.y) / zoom),
  }
}

/**
 * 根据缩放值解析点阵背景所属的缩放桶。
 *
 * @param zoom - React Flow 当前缩放倍率。
 * @returns 匹配到的缩放桶索引。
 */
const getZoomBucketIndex = (zoom: number) => {
  for (const [index, bucket] of ZOOM_BUCKETS.entries()) {
    if (zoom <= bucket.maxZoom) {
      return index
    }
  }

  return ZOOM_BUCKETS.length - 1
}

/**
 * 使用滞后阈值解析下一帧点阵背景缩放桶。
 *
 * @param zoom - React Flow 当前缩放倍率。
 * @param currentIndex - 当前已经应用的缩放桶索引。
 * @returns 应继续使用或切换到的缩放桶索引。
 */
const resolveZoomBucketIndex = (zoom: number, currentIndex: number) => {
  const currentBucket = ZOOM_BUCKETS[currentIndex]
  const previousBucket = ZOOM_BUCKETS[currentIndex - 1]

  const shouldAdvance = currentBucket
    ? zoom > currentBucket.maxZoom * (1 + ZOOM_BUCKET_HYSTERESIS)
    : false
  const shouldRetreat = previousBucket
    ? zoom < previousBucket.maxZoom * (1 - ZOOM_BUCKET_HYSTERESIS)
    : false

  if (shouldAdvance || shouldRetreat) {
    return getZoomBucketIndex(zoom)
  }

  return currentIndex
}

/**
 * 渲染随缩放分桶变化的画布点阵背景。
 *
 * @returns React Flow 背景元素。
 */
function ProjectFlowBackgrounds() {
  const zoomLevel = useProjectCanvasStore((state) => state.zoomLevel)
  const zoom = resolveBackgroundZoom(zoomLevel)
  const [bucketIndex, setBucketIndex] = useState(() => getZoomBucketIndex(zoom))

  useEffect(() => {
    setBucketIndex((currentIndex) => resolveZoomBucketIndex(zoom, currentIndex))
  }, [zoom])

  // getZoomBucketIndex/resolveZoomBucketIndex 只返回合法下标。
  const bucket = ZOOM_BUCKETS[bucketIndex]!
  const gap = 16 * bucket.gapMultiplier
  const size = FLOW_BACKGROUND_DOT_SIZE * Math.max(bucket.gapMultiplier, 1)

  return (
    <>
      <Background variant={BackgroundVariant.Dots} gap={gap} size={size} color="var(--color-dot)" />
      <Background
        id="dot-glow-bg"
        variant={BackgroundVariant.Dots}
        gap={gap}
        size={size}
        color="var(--color-dot-pattern)"
      />
    </>
  )
}

/**
 * 渲染项目画布的 React Flow 交互主体。
 *
 * @param props - 视口扩展属性。
 * @param props.enableViewportZoom - 是否允许滚轮和触控板缩放画布。
 * @param props.extraNodeTypes - 按页面注入的额外 React Flow 节点组件。
 * @param props.extraNodes - 按页面注入的额外 React Flow 节点数据。
 * @returns 包含画布节点、背景和视口控制逻辑的元素。
 */
function CanvasViewportContent({
  enableViewportZoom,
  extraNodeTypes,
  extraNodes,
  showProjectNodes,
}: CanvasViewportContentProps) {
  const clearHighlights = useProjectCanvasStore((state) => state.clearHighlights)
  const commitManualNodePositions = useProjectCanvasStore(
    (state) => state.commitManualNodePositions,
  )
  const highlightedNodeIds = useProjectCanvasStore((state) => state.highlightedNodeIds)
  const nodes = useProjectCanvasStore((state) => state.nodes)
  const onNodesChange = useProjectCanvasStore((state) => state.onNodesChange)
  const onWorkspaceNodesChange = useProjectCanvasStore((state) => state.onWorkspaceNodesChange)
  const registerViewportController = useProjectCanvasStore(
    (state) => state.registerViewportController,
  )
  const syncZoomLevel = useProjectCanvasStore((state) => state.syncZoomLevel)
  const syncPlacementBounds = useProjectCanvasStore((state) => state.syncPlacementBounds)
  const updateNodePositions = useProjectCanvasStore((state) => state.updateNodePositions)
  const workspaceNodes = useProjectCanvasStore((state) => state.workspaceNodes)

  const dragStartPositionRef = useRef<{ id: string; x: number; y: number } | null>(null)
  const flowInstanceRef = useRef<ReactFlowInstance<CanvasViewportNode> | null>(null)
  const hasAppliedEmptyViewportRef = useRef(false)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const [isFlowReady, setIsFlowReady] = useState(false)
  const [localExtraNodes, setLocalExtraNodes] = useState(extraNodes)
  const viewportNodeTypes = useMemo(
    () =>
      extraNodeTypes
        ? { ...PROJECT_CANVAS_NODE_TYPES, ...extraNodeTypes }
        : PROJECT_CANVAS_NODE_TYPES,
    [extraNodeTypes],
  )
  const visibleProjectNodes = showProjectNodes ? nodes : EMPTY_PROJECT_NODES
  const managedNodes = useMemo<CanvasViewportNode[]>(
    () => [...visibleProjectNodes, ...workspaceNodes],
    [visibleProjectNodes, workspaceNodes],
  )
  const viewportNodes = useMemo<CanvasViewportNode[]>(
    () => (localExtraNodes.length > 0 ? [...managedNodes, ...localExtraNodes] : managedNodes),
    [localExtraNodes, managedNodes],
  )
  const projectNodeIds = useMemo(
    () => new Set(visibleProjectNodes.map((node) => node.id)),
    [visibleProjectNodes],
  )
  const extraNodeIds = useMemo(
    () => new Set(localExtraNodes.map((node) => node.id)),
    [localExtraNodes],
  )
  const workspaceNodeIds = useMemo(
    () => new Set(workspaceNodes.map((node) => node.id)),
    [workspaceNodes],
  )
  const managedNodeIds = useMemo(() => new Set(managedNodes.map((node) => node.id)), [managedNodes])

  useEffect(() => {
    if (highlightedNodeIds.length === 0) {
      return
    }

    const timer = window.setTimeout(() => clearHighlights(), 1200)
    return () => window.clearTimeout(timer)
  }, [clearHighlights, highlightedNodeIds])

  useEffect(() => {
    setLocalExtraNodes(extraNodes)
  }, [extraNodes])

  useEffect(() => {
    if (!isFlowReady) {
      return
    }

    if (hasAppliedEmptyViewportRef.current) {
      return
    }

    hasAppliedEmptyViewportRef.current = true
    syncZoomLevel(DEFAULT_CANVAS_ZOOM)
    void flowInstanceRef.current?.setViewport(
      {
        x: 0,
        y: 0,
        zoom: DEFAULT_CANVAS_ZOOM,
      },
      { duration: VIEWPORT_ANIMATION_DURATION },
    )
  }, [isFlowReady, syncZoomLevel])

  const syncCurrentPlacementBounds = useCallback(() => {
    const flowInstance = flowInstanceRef.current
    const reactFlowElement = wrapperRef.current?.querySelector('.react-flow')

    if (!flowInstance || !reactFlowElement) {
      return
    }

    syncPlacementBounds(
      resolvePlacementBounds({
        bounds: reactFlowElement.getBoundingClientRect(),
        viewport: flowInstance.getViewport(),
      }),
    )
  }, [syncPlacementBounds])

  const zoomAroundCenter = useCallback((zoom: number) => {
    const flowInstance = flowInstanceRef.current
    const reactFlowElement = wrapperRef.current?.querySelector('.react-flow')

    if (!flowInstance || !reactFlowElement) {
      return
    }

    const viewport = flowInstance.getViewport()
    assertFiniteViewportZoom(viewport.zoom, 'zoom around center')

    const bounds = reactFlowElement.getBoundingClientRect()
    const centerX = bounds.width / 2
    const centerY = bounds.height / 2
    const flowCenterX = (centerX - viewport.x) / viewport.zoom
    const flowCenterY = (centerY - viewport.y) / viewport.zoom
    const nextZoom = clamp(zoom, ZOOM_MIN, ZOOM_MAX)

    void flowInstance.setViewport(
      {
        x: centerX - flowCenterX * nextZoom,
        y: centerY - flowCenterY * nextZoom,
        zoom: nextZoom,
      },
      { duration: VIEWPORT_ANIMATION_DURATION },
    )
  }, [])

  const registerController = useCallback(() => {
    registerViewportController({
      panBy: (dx, dy) => {
        const flowInstance = flowInstanceRef.current

        if (!flowInstance) {
          return
        }

        const viewport = flowInstance.getViewport()
        void flowInstance.setViewport({
          x: viewport.x + dx,
          y: viewport.y + dy,
          zoom: viewport.zoom,
        })
      },
      zoomIn: () => {
        const flowInstance = flowInstanceRef.current

        if (!flowInstance) {
          return
        }

        const { zoom } = flowInstance.getViewport()
        assertFiniteViewportZoom(zoom, 'zoom in')
        zoomAroundCenter(zoom * ZOOM_IN_FACTOR)
      },
      zoomOut: () => {
        const flowInstance = flowInstanceRef.current

        if (!flowInstance) {
          return
        }

        const { zoom } = flowInstance.getViewport()
        assertFiniteViewportZoom(zoom, 'zoom out')
        zoomAroundCenter(zoom / ZOOM_IN_FACTOR)
      },
      zoomTo100: () => zoomAroundCenter(1),
      zoomToFit: () => {
        const flowInstance = flowInstanceRef.current

        if (!flowInstance) {
          return
        }

        void flowInstance.fitView({
          duration: VIEWPORT_ANIMATION_DURATION,
          maxZoom: ZOOM_MAX,
          minZoom: ZOOM_MIN,
          padding: FIT_VIEW_PADDING,
        })
      },
      zoomToSelection: () => {
        const flowInstance = flowInstanceRef.current

        if (!flowInstance) {
          return
        }

        void flowInstance.fitView({
          duration: VIEWPORT_ANIMATION_DURATION,
          maxZoom: ZOOM_MAX,
          minZoom: ZOOM_MIN,
          padding: FIT_VIEW_PADDING,
        })
      },
    })
  }, [registerViewportController, zoomAroundCenter])

  const handleInit = useCallback(
    (instance: ReactFlowInstance<CanvasViewportNode>) => {
      flowInstanceRef.current = instance
      setIsFlowReady(true)
      registerController()
      const reactFlowElement = wrapperRef.current?.querySelector('.react-flow')

      if (reactFlowElement) {
        syncPlacementBounds(
          resolvePlacementBounds({
            bounds: reactFlowElement.getBoundingClientRect(),
            viewport: instance.getViewport(),
          }),
        )
      }
    },
    [registerController, syncPlacementBounds],
  )

  const handleNodesChange = useCallback(
    (changes: NodeChange<CanvasViewportNode>[]) => {
      const projectNodeChanges: NodeChange<ProjectCanvasFlowNode>[] = []
      const workspaceNodeChanges: NodeChange<ProjectCanvasWorkspaceNode>[] = []
      const extraNodeChanges: NodeChange<CanvasViewportExtraNode>[] = []

      for (const change of changes) {
        if (change.type === 'add' || change.type === 'replace') {
          continue
        }

        if (projectNodeIds.has(change.id)) {
          projectNodeChanges.push(change)
          continue
        }

        if (workspaceNodeIds.has(change.id)) {
          workspaceNodeChanges.push(change)
          continue
        }

        if (extraNodeIds.has(change.id)) {
          extraNodeChanges.push(change)
        }
      }

      if (extraNodeChanges.length > 0) {
        setLocalExtraNodes((currentNodes) => applyNodeChanges(extraNodeChanges, currentNodes))
      }

      if (projectNodeChanges.length > 0) {
        onNodesChange(projectNodeChanges)
      }

      if (workspaceNodeChanges.length > 0) {
        onWorkspaceNodesChange(workspaceNodeChanges)
      }
    },
    [extraNodeIds, onNodesChange, onWorkspaceNodesChange, projectNodeIds, workspaceNodeIds],
  )

  const handleNodeDragStart = useCallback((_event: unknown, node: CanvasViewportNode) => {
    dragStartPositionRef.current = {
      id: node.id,
      x: node.position.x,
      y: node.position.y,
    }
  }, [])

  const handleNodeDragStop = useCallback(
    (_event: unknown, node: CanvasViewportNode) => {
      const dragStartPosition = dragStartPositionRef.current
      dragStartPositionRef.current = null

      if (!managedNodeIds.has(node.id)) {
        return
      }

      const commitResult = commitManualNodePositions([
        {
          id: node.id,
          x: node.position.x,
          y: node.position.y,
        },
      ])

      if (!commitResult.accepted && dragStartPosition?.id === node.id) {
        updateNodePositions([dragStartPosition])
      }
    },
    [commitManualNodePositions, managedNodeIds, updateNodePositions],
  )

  useEffect(() => {
    registerController()
  }, [registerController])

  useEffect(() => {
    if (!isFlowReady) {
      return
    }

    syncCurrentPlacementBounds()
  }, [isFlowReady, syncCurrentPlacementBounds])

  useEffect(() => {
    if (!isFlowReady || typeof ResizeObserver === 'undefined') {
      return
    }

    const element = wrapperRef.current

    if (!element) {
      return
    }

    const observer = new ResizeObserver(() => syncCurrentPlacementBounds())
    observer.observe(element)

    return () => observer.disconnect()
  }, [isFlowReady, syncCurrentPlacementBounds])

  useEffect(() => {
    return () => {
      flowInstanceRef.current = null
      setIsFlowReady(false)
      registerViewportController(null)
    }
  }, [registerViewportController])

  const defaultViewport = {
    x: 0,
    y: 0,
    zoom: DEFAULT_CANVAS_ZOOM,
  }

  return (
    <div ref={wrapperRef} className="absolute inset-0">
      <ReactFlow<CanvasViewportNode>
        className="project-react-flow"
        defaultViewport={defaultViewport}
        edges={EMPTY_EDGES}
        elementsSelectable={false}
        maxZoom={ZOOM_MAX}
        minZoom={ZOOM_MIN}
        nodes={viewportNodes}
        nodesConnectable={false}
        nodesDraggable
        nodesFocusable={false}
        nodeTypes={viewportNodeTypes}
        onInit={handleInit}
        onMove={(_, viewport) => {
          assertFiniteViewportZoom(viewport.zoom, 'move')
          syncZoomLevel(viewport.zoom)
          const reactFlowElement = wrapperRef.current?.querySelector('.react-flow')

          if (!reactFlowElement) {
            return
          }

          syncPlacementBounds(
            resolvePlacementBounds({
              bounds: reactFlowElement.getBoundingClientRect(),
              viewport,
            }),
          )
        }}
        onNodeDragStart={handleNodeDragStart}
        onNodeDragStop={handleNodeDragStop}
        onNodesChange={handleNodesChange}
        onlyRenderVisibleElements
        panOnDrag
        panOnScroll={!enableViewportZoom}
        panOnScrollMode={PanOnScrollMode.Free}
        preventScrolling
        proOptions={{ hideAttribution: true }}
        selectionOnDrag={false}
        zoomOnDoubleClick={false}
        zoomOnPinch={enableViewportZoom}
        zoomOnScroll={enableViewportZoom}
      >
        <ProjectFlowBackgrounds />
        <ProjectCanvasGlow />
      </ReactFlow>
    </div>
  )
}

/**
 * 提供 React Flow 上下文并渲染项目画布视口。
 *
 * @param props - 画布视口扩展属性。
 * @param props.enableViewportZoom - 是否允许滚轮和触控板缩放画布。
 * @param props.extraNodeTypes - 按页面注入的额外 React Flow 节点组件。
 * @param props.extraNodes - 按页面注入的额外 React Flow 节点数据。
 * @param props.showProjectNodes - 是否把 project-canvas store 中的节点渲染进 React Flow。
 * @returns 项目画布视口组件。
 */
export default function CanvasViewport({
  enableViewportZoom = false,
  extraNodeTypes,
  extraNodes = [],
  showProjectNodes = true,
}: CanvasViewportProps) {
  return (
    <ReactFlowProvider>
      <CanvasViewportContent
        enableViewportZoom={enableViewportZoom}
        extraNodeTypes={extraNodeTypes}
        extraNodes={extraNodes}
        showProjectNodes={showProjectNodes}
      />
    </ReactFlowProvider>
  )
}
