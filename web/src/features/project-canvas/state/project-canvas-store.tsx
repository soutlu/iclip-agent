import { applyNodeChanges } from '@xyflow/react'
import type { ReactNode } from 'react'
import { createContext, useContext } from 'react'
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { ProjectCanvasFlowNode } from '@/features/project-canvas/components/nodes/project-canvas-node.types'
import {
  areJsonSerializableValuesEqual,
  buildSelectedNodeSummary,
  clampZoom,
  decorateNodes,
  hasManualNodeCollision,
  preserveEqualSerializableValue,
  resolveProjectCanvasNodesCollisionLayout,
  resolveZoomLevelFromViewportZoom,
  updateProjectCanvasNodeLayout,
} from './project-canvas-store.layout'
import {
  hasDeferredCanvasNodes,
  normalizeCanvasArtifacts,
  reconcileProjectCanvasNodes,
  scheduleViewportFocusOnNode,
} from './project-canvas-store.nodes'
import {
  DEFAULT_CANVAS_ZOOM_LEVEL,
  type ProjectCanvasPositionedNode,
  type ProjectCanvasState,
  type ProjectCanvasStore,
  type ProjectCanvasWorkspaceNode,
  ZOOM_SELECTION_LEVEL,
  ZOOM_STEP,
} from './project-canvas-store.types'

export {
  DEFAULT_CANVAS_ZOOM_LEVEL,
  PROJECT_CANVAS_STANDARD_NODE_SIZE,
} from './project-canvas-store.types'
export type {
  ProjectCanvasLayout,
  ProjectCanvasLayoutNode,
  ProjectCanvasPlacementBounds,
  ProjectCanvasPositionedNode,
  ProjectCanvasState,
  ProjectCanvasStore,
  ProjectCanvasWorkspaceNode,
  ProjectCanvasWorkspaceNodeInput,
} from './project-canvas-store.types'

/**
 * 将 store 管理的项目节点和 workspace 节点投影为可持久化布局快照。
 *
 * @param nodes - artifact 项目节点。
 * @param workspaceNodes - Direct Canvas 页面业务节点。
 * @returns 只包含稳定 id、坐标和布局模式的完整节点快照。
 */
const projectCanvasLayoutNodesFromState = (
  nodes: ProjectCanvasFlowNode[],
  workspaceNodes: ProjectCanvasWorkspaceNode[],
) =>
  [...nodes, ...workspaceNodes].map((node) => ({
    layoutMode: node.data.layoutMode,
    nodeId: node.id,
    x: node.position.x,
    y: node.position.y,
  }))

/**
 * 按顺序比较两组节点 id，判断业务拓扑是否变化。
 *
 * @param currentNodes - 当前基线节点。
 * @param nextNodes - 下一份业务节点。
 * @returns id 数量与顺序完全一致时返回 true。
 */
const haveSameNodeIds = (currentNodes: Array<{ id: string }>, nextNodes: Array<{ id: string }>) =>
  currentNodes.length === nextNodes.length &&
  currentNodes.every((node, index) => node.id === nextNodes[index]?.id)

/**
 * 创建项目画布 Zustand store。
 *
 * @param projectId - 当前画布作用域 id，用于生成稳定的 artifact 节点标识。
 * @returns 包含节点同步、布局提交和视口控制动作的 vanilla store。
 */
export const createProjectCanvasStore = (projectId: string) =>
  createStore<ProjectCanvasState>((set, get) => {
    const exportTargets = new Map<string, HTMLElement>()

    return {
      artifacts: [],
      clearHighlights: () =>
        set((state) => {
          const nodes = decorateNodes({
            highlightedNodeIds: [],
            highlightToken: state.highlightToken,
            nodes: state.nodes,
            selectedNodeId: state.selectedNodeId,
          })

          return {
            highlightedNodeIds: [],
            nodes,
          }
        }),
      commitManualNodePositions: (positions) => {
        let didCommit = false
        set((state) => {
          if (positions.length === 0) {
            return state
          }

          const positionMap = new Map(positions.map((position) => [position.id, position] as const))
          let hasMatchedPosition = false
          const candidateNodes = state.nodes.map((node) => {
            const nextPosition = positionMap.get(node.id)

            if (!nextPosition) {
              return node
            }

            hasMatchedPosition = true

            return updateProjectCanvasNodeLayout({
              layoutMode: 'manual',
              node,
              position: {
                x: nextPosition.x,
                y: nextPosition.y,
              },
            })
          })
          const candidateWorkspaceNodes = state.workspaceNodes.map((node) => {
            const nextPosition = positionMap.get(node.id)

            if (!nextPosition) {
              return node
            }

            hasMatchedPosition = true

            return updateProjectCanvasNodeLayout({
              layoutMode: 'manual',
              node,
              position: {
                x: nextPosition.x,
                y: nextPosition.y,
              },
            })
          })

          const candidateCanvasNodes: ProjectCanvasPositionedNode[] = [
            ...candidateNodes,
            ...candidateWorkspaceNodes,
          ]

          if (!hasMatchedPosition || hasManualNodeCollision(candidateCanvasNodes)) {
            return state
          }

          const collisionNodes = resolveProjectCanvasNodesCollisionLayout(candidateCanvasNodes)
          const collisionNodesById = new Map(collisionNodes.map((node) => [node.id, node] as const))
          const layoutNodes = candidateNodes.map((node) => {
            const layoutNode = collisionNodesById.get(node.id)

            return layoutNode
              ? updateProjectCanvasNodeLayout({
                  layoutMode: layoutNode.data.layoutMode,
                  node,
                  position: layoutNode.position,
                })
              : node
          })
          const nodes = decorateNodes({
            highlightedNodeIds: state.highlightedNodeIds,
            highlightToken: state.highlightToken,
            nodes: layoutNodes,
            selectedNodeId: state.selectedNodeId,
          })
          const workspaceNodes = candidateWorkspaceNodes.map((node) => {
            const layoutNode = collisionNodesById.get(node.id)

            return layoutNode
              ? updateProjectCanvasNodeLayout({
                  layoutMode: layoutNode.data.layoutMode,
                  node,
                  position: layoutNode.position,
                })
              : node
          })
          const persistedLayoutNodes = projectCanvasLayoutNodesFromState(nodes, workspaceNodes)

          didCommit = true
          return {
            hydratedLayoutNodes: persistedLayoutNodes,
            layoutCommitVersion: state.layoutHydrated
              ? state.layoutCommitVersion + 1
              : state.layoutCommitVersion,
            nodes,
            selectedNodeSummary: buildSelectedNodeSummary(nodes, state.selectedNodeId),
            workspaceNodes,
          }
        })

        return { accepted: didCommit }
      },
      exportTargetVersion: 0,
      flashHighlights: (nodeIds) =>
        set((state) => {
          const highlightToken = state.highlightToken + 1
          const nodes = decorateNodes({
            highlightedNodeIds: nodeIds,
            highlightToken,
            nodes: state.nodes,
            selectedNodeId: state.selectedNodeId,
          })

          return {
            highlightedNodeIds: nodeIds,
            highlightToken,
            nodes,
          }
        }),
      getExportTarget: (nodeId) => {
        if (!nodeId) {
          return null
        }

        return exportTargets.get(nodeId) ?? null
      },
      getLayoutSnapshot: () => {
        const state = get()

        return {
          nodes: projectCanvasLayoutNodesFromState(state.nodes, state.workspaceNodes),
          schemaVersion: 1,
        }
      },
      highlightedNodeIds: [],
      highlightToken: 0,
      hydrateLayout: (layout) =>
        set((state) => {
          const positionMap = new Map(layout.nodes.map((node) => [node.nodeId, node] as const))
          const nodes = state.nodes.map((node) => {
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
          const workspaceNodes = state.workspaceNodes.map((node) => {
            const position = positionMap.get(node.id)

            if (!position) {
              return node
            }

            return {
              ...node,
              data: {
                ...node.data,
                layoutMode: position.layoutMode,
              },
              position: {
                x: position.x,
                y: position.y,
              },
            }
          })

          return {
            hydratedLayoutNodes: layout.nodes,
            layoutHydrated: true,
            nodes,
            selectedNodeSummary: buildSelectedNodeSummary(nodes, state.selectedNodeId),
            workspaceNodes,
          }
        }),
      layoutCommitVersion: 0,
      layoutHydrated: false,
      hydratedLayoutNodes: [],
      nodes: [],
      onNodesChange: (changes) => {
        set((state) => {
          const nextNodes = applyNodeChanges<ProjectCanvasFlowNode>(changes, state.nodes)
          const shouldResolveDimensionCollisions = changes.some(
            (change) => change.type === 'dimensions' && change.resizing !== true,
          )
          const nodes = shouldResolveDimensionCollisions
            ? resolveProjectCanvasNodesCollisionLayout(nextNodes)
            : nextNodes

          const shouldCommitLayout = shouldResolveDimensionCollisions && state.layoutHydrated

          return {
            layoutCommitVersion: shouldCommitLayout
              ? state.layoutCommitVersion + 1
              : state.layoutCommitVersion,
            nodes,
            selectedNodeSummary: buildSelectedNodeSummary(nodes, state.selectedNodeId),
          }
        })
      },
      onWorkspaceNodesChange: (changes) =>
        set((state) => ({
          workspaceNodes: applyNodeChanges<ProjectCanvasWorkspaceNode>(
            changes,
            state.workspaceNodes,
          ),
        })),
      panCanvas: (dx, dy) => {
        const viewportController = get().viewportController

        if (viewportController) {
          viewportController.panBy(dx, dy)
        }
      },
      placementBounds: null,
      projectMedia: [],
      registerExportTarget: (nodeId, element) => {
        const currentElement = exportTargets.get(nodeId) ?? null

        if (currentElement === element) {
          return
        }

        if (element) {
          exportTargets.set(nodeId, element)
        } else {
          exportTargets.delete(nodeId)
        }

        set((state) => ({
          exportTargetVersion: state.exportTargetVersion + 1,
        }))
      },
      registerViewportController: (viewportController) => set({ viewportController }),
      requestLayoutCommit: () =>
        set((state) => ({
          layoutCommitVersion: state.layoutHydrated
            ? state.layoutCommitVersion + 1
            : state.layoutCommitVersion,
        })),
      selectNode: (selectedNodeId) =>
        set((state) => {
          const nodes = decorateNodes({
            highlightedNodeIds: state.highlightedNodeIds,
            highlightToken: state.highlightToken,
            nodes: state.nodes,
            selectedNodeId,
          })

          return {
            nodes,
            selectedNodeId,
            selectedNodeSummary: buildSelectedNodeSummary(nodes, selectedNodeId),
          }
        }),
      selectedNodeId: null,
      selectedNodeSummary: null,
      syncArtifacts: (artifacts) => {
        let focusNodeId: string | null = null
        const normalizedArtifacts = normalizeCanvasArtifacts(artifacts)

        set((state) => {
          if (areJsonSerializableValuesEqual(state.artifacts, normalizedArtifacts)) {
            return state
          }

          const reconciledState = reconcileProjectCanvasNodes({
            artifacts: normalizedArtifacts,
            placementBounds: state.placementBounds,
            projectId,
            state,
          })

          focusNodeId = state.nodes.length > 0 ? reconciledState.focusNodeId : null
          return {
            ...reconciledState,
            artifacts: normalizedArtifacts,
            layoutCommitVersion:
              state.layoutHydrated && !haveSameNodeIds(state.nodes, reconciledState.nodes)
                ? state.layoutCommitVersion + 1
                : state.layoutCommitVersion,
          }
        })

        if (focusNodeId) {
          scheduleViewportFocusOnNode(get, focusNodeId)
        }
      },
      syncPlacementBounds: (bounds) => {
        set((state) => {
          const currentBounds = state.placementBounds
          const hasSameBounds =
            currentBounds &&
            currentBounds.minX === bounds.minX &&
            currentBounds.maxX === bounds.maxX &&
            currentBounds.minY === bounds.minY
          const shouldCreateDeferredNodes = hasDeferredCanvasNodes({
            artifacts: state.artifacts,
            nodes: state.nodes,
            projectId,
          })

          if (hasSameBounds && !shouldCreateDeferredNodes) {
            return state
          }

          if (!shouldCreateDeferredNodes) {
            return {
              placementBounds: bounds,
            }
          }

          const reconciledState = reconcileProjectCanvasNodes({
            artifacts: state.artifacts,
            placementBounds: bounds,
            projectId,
            state: {
              ...state,
              placementBounds: bounds,
            },
          })

          return {
            ...reconciledState,
            layoutCommitVersion:
              state.layoutHydrated && !haveSameNodeIds(state.nodes, reconciledState.nodes)
                ? state.layoutCommitVersion + 1
                : state.layoutCommitVersion,
            placementBounds: bounds,
          }
        })
      },
      syncProjectMedia: (media) => {
        set((state) => {
          const projectMedia = preserveEqualSerializableValue(state.projectMedia, media)

          if (projectMedia === state.projectMedia) {
            return state
          }

          return { projectMedia }
        })
      },
      syncWorkspaceNodes: (workspaceNodeInputs) =>
        set((state) => {
          const existingNodesById = new Map(
            state.workspaceNodes.map((node) => [node.id, node] as const),
          )
          const layoutNodesById = new Map(
            state.hydratedLayoutNodes.map((node) => [node.nodeId, node] as const),
          )
          const workspaceNodes: ProjectCanvasWorkspaceNode[] = workspaceNodeInputs.map((node) => {
            const existingNode = existingNodesById.get(node.id)
            const layoutNode = layoutNodesById.get(node.id)

            return {
              ...node,
              data: {
                ...node.data,
                layoutMode:
                  existingNode?.data.layoutMode ?? layoutNode?.layoutMode ?? ('auto' as const),
              },
              position:
                existingNode?.position ??
                (layoutNode
                  ? {
                      x: layoutNode.x,
                      y: layoutNode.y,
                    }
                  : node.position),
            }
          })
          const nextLayoutNodes = projectCanvasLayoutNodesFromState(state.nodes, workspaceNodes)
          const shouldCommitLayout =
            state.layoutHydrated &&
            !haveSameNodeIds(
              state.hydratedLayoutNodes.map((node) => ({ id: node.nodeId })),
              nextLayoutNodes.map((node) => ({ id: node.nodeId })),
            )

          return {
            hydratedLayoutNodes: shouldCommitLayout ? nextLayoutNodes : state.hydratedLayoutNodes,
            layoutCommitVersion: shouldCommitLayout
              ? state.layoutCommitVersion + 1
              : state.layoutCommitVersion,
            workspaceNodes,
          }
        }),
      syncZoomLevel: (zoom) =>
        set((state) => {
          const nextZoomLevel = resolveZoomLevelFromViewportZoom(zoom)

          if (state.zoomLevel === nextZoomLevel) {
            return state
          }

          return {
            zoomLevel: nextZoomLevel,
          }
        }),
      updateNodePositions: (positions) => {
        set((state) => {
          if (positions.length === 0) {
            return state
          }

          const positionMap = new Map(positions.map((position) => [position.id, position] as const))
          let hasPositionChanges = false

          const nextNodes = state.nodes.map((node) => {
            const nextPosition = positionMap.get(node.id)

            if (!nextPosition) {
              return node
            }

            if (node.position.x === nextPosition.x && node.position.y === nextPosition.y) {
              return node
            }

            hasPositionChanges = true

            return updateProjectCanvasNodeLayout({
              layoutMode: node.data.layoutMode,
              node,
              position: {
                x: nextPosition.x,
                y: nextPosition.y,
              },
            })
          })
          const nextWorkspaceNodes = state.workspaceNodes.map((node) => {
            const nextPosition = positionMap.get(node.id)

            if (!nextPosition) {
              return node
            }

            if (node.position.x === nextPosition.x && node.position.y === nextPosition.y) {
              return node
            }

            hasPositionChanges = true

            return updateProjectCanvasNodeLayout({
              layoutMode: node.data.layoutMode,
              node,
              position: {
                x: nextPosition.x,
                y: nextPosition.y,
              },
            })
          })

          if (!hasPositionChanges) {
            return state
          }

          return {
            nodes: nextNodes,
            selectedNodeSummary: buildSelectedNodeSummary(nextNodes, state.selectedNodeId),
            workspaceNodes: nextWorkspaceNodes,
          }
        })
      },
      viewportController: null,
      workspaceNodes: [],
      zoomIn: () => {
        const viewportController = get().viewportController

        if (viewportController) {
          viewportController.zoomIn()
          return
        }

        set((state) => ({
          zoomLevel: clampZoom(state.zoomLevel + ZOOM_STEP),
        }))
      },
      zoomLevel: DEFAULT_CANVAS_ZOOM_LEVEL,
      zoomOut: () => {
        const viewportController = get().viewportController

        if (viewportController) {
          viewportController.zoomOut()
          return
        }

        set((state) => ({
          zoomLevel: clampZoom(state.zoomLevel - ZOOM_STEP),
        }))
      },
      zoomTo100: () => {
        const viewportController = get().viewportController

        if (viewportController) {
          viewportController.zoomTo100()
          return
        }

        set(() => ({
          zoomLevel: 100,
        }))
      },
      zoomToFit: () => {
        const viewportController = get().viewportController

        if (viewportController) {
          viewportController.zoomToFit()
        }
      },
      zoomToSelection: () => {
        const { selectedNodeId, viewportController } = get()

        if (viewportController) {
          viewportController.zoomToSelection(selectedNodeId)
          return
        }

        set({ zoomLevel: ZOOM_SELECTION_LEVEL })
      },
    }
  })

const ProjectCanvasStoreContext = createContext<ProjectCanvasStore | null>(null)

/**
 * 向项目画布子树提供当前项目的 store。
 *
 * @param props - Provider 的子元素和已创建的 store。
 * @param props.children - 需要读取画布状态的 React 子树。
 * @param props.store - 当前项目对应的画布 store。
 * @returns 注入 store context 的 React 元素。
 */
export function ProjectCanvasStoreProvider({
  children,
  store,
}: {
  children: ReactNode
  store: ProjectCanvasStore
}) {
  return (
    <ProjectCanvasStoreContext.Provider value={store}>
      {children}
    </ProjectCanvasStoreContext.Provider>
  )
}

/**
 * 从项目画布 store 中读取派生状态。
 *
 * @param selector - 从完整 store 状态中选择调用方所需数据的函数。
 * @returns selector 计算出的状态片段。
 * @throws 当组件没有被 ProjectCanvasStoreProvider 包裹时抛出错误。
 */
export const useProjectCanvasStore = <T,>(selector: (state: ProjectCanvasState) => T) => {
  const store = useContext(ProjectCanvasStoreContext)

  if (!store) {
    throw new Error('useProjectCanvasStore 必须在 ProjectCanvasStoreProvider 内使用。')
  }

  return useStore(store, selector)
}

/**
 * 读取当前项目画布 vanilla store，供持久化协调器执行原子快照读取。
 *
 * @returns 当前 Provider 注入的 store 实例。
 * @throws 当组件没有被 ProjectCanvasStoreProvider 包裹时抛出错误。
 */
export const useProjectCanvasStoreApi = () => {
  const store = useContext(ProjectCanvasStoreContext)

  if (!store) {
    throw new Error('useProjectCanvasStoreApi 必须在 ProjectCanvasStoreProvider 内使用。')
  }

  return store
}
