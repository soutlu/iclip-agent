import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  type ProjectCanvasWorkspaceNodeInput,
  useProjectCanvasStore,
  useProjectCanvasStoreApi,
} from '@/features/project-canvas'
import {
  getProducerProjectCanvasLayout,
  type ProducerProjectCanvasLayout,
  replaceProducerProjectCanvasLayout,
  type ReplaceProducerProjectCanvasLayoutInput,
} from '@/features/projects'
import { ApiError } from '@/shared/api/client'
import RouteBootShell from '@/shared/ui/RouteBootShell'

interface ProjectCanvasLayoutCoordinatorProps {
  children: ReactNode
  projectId: string
  workspaceNodes: ProjectCanvasWorkspaceNodeInput[]
}

type CanvasLayoutRecoveryAction = 'load-latest' | 'retry-save'

/**
 * 构造单个项目画布布局的 TanStack Query key。
 *
 * @param projectId - Direct Canvas 项目 id。
 * @returns 项目隔离的稳定 query key。
 */
const projectCanvasLayoutQueryKey = (projectId: string) =>
  ['producer-project-canvas-layout', projectId] as const

/**
 * 判断布局重载在途期间是否出现了新的坐标或布局模式编辑。
 *
 * 新增的 auto 节点属于业务拓扑变化，由响应后的 reconciliation 处理；新增 manual
 * 节点以及既有节点的位置或模式变化都属于不能被远端响应静默覆盖的本地编辑。
 */
const hasLayoutEditsSince = (
  baselineNodes: ProducerProjectCanvasLayout['nodes'],
  currentNodes: ProducerProjectCanvasLayout['nodes'],
) => {
  const baselineNodesById = new Map(baselineNodes.map((node) => [node.nodeId, node] as const))

  return currentNodes.some((node) => {
    const baselineNode = baselineNodesById.get(node.nodeId)

    if (!baselineNode) {
      return node.layoutMode === 'manual'
    }

    return (
      node.x !== baselineNode.x ||
      node.y !== baselineNode.y ||
      node.layoutMode !== baselineNode.layoutMode
    )
  })
}

/**
 * 为 Direct Canvas 协调服务器布局与 Zustand 交互状态。
 *
 * TanStack Query 独占服务器 revision、时间和请求错误；Zustand 只保留当前节点、
 * hydrate 基线与显式 commit 序号。保存始终串行，并在前一次完成后合并到最新快照。
 */
export default function ProjectCanvasLayoutCoordinator({
  children,
  projectId,
  workspaceNodes,
}: ProjectCanvasLayoutCoordinatorProps) {
  const queryClient = useQueryClient()
  const canvasStore = useProjectCanvasStoreApi()
  const hydrateLayout = useProjectCanvasStore((state) => state.hydrateLayout)
  const layoutCommitVersion = useProjectCanvasStore((state) => state.layoutCommitVersion)
  const layoutHydrated = useProjectCanvasStore((state) => state.layoutHydrated)
  const requestLayoutCommit = useProjectCanvasStore((state) => state.requestLayoutCommit)
  const syncWorkspaceNodes = useProjectCanvasStore((state) => state.syncWorkspaceNodes)
  const [recoveryAction, setRecoveryAction] = useState<CanvasLayoutRecoveryAction | null>(null)
  const hydratedRevisionRef = useRef<number | null>(null)
  const savedCommitVersionRef = useRef(0)
  const saveLoopRunningRef = useRef(false)
  const workspaceNodesRef = useRef(workspaceNodes)
  workspaceNodesRef.current = workspaceNodes
  const queryKey = useMemo(() => projectCanvasLayoutQueryKey(projectId), [projectId])
  const {
    data: loadedLayout,
    error: layoutLoadError,
    fetchStatus,
    isFetchedAfterMount,
    refetch: refetchLayout,
  } = useQuery({
    queryFn: ({ signal }) => getProducerProjectCanvasLayout(projectId, { signal }),
    queryKey,
    refetchOnMount: 'always',
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    structuralSharing: (cachedData, fetchedData) => {
      const cachedLayout = cachedData as ProducerProjectCanvasLayout | undefined
      const fetchedLayout = fetchedData as ProducerProjectCanvasLayout

      // 旧页面的在途 PUT 可能比新页面的 GET 更晚完成，revision 只能向前推进。
      return cachedLayout && cachedLayout.revision > fetchedLayout.revision
        ? cachedLayout
        : fetchedLayout
    },
  })
  const {
    error: layoutSaveError,
    isPending: isSaving,
    mutateAsync: saveLayout,
    reset: resetLayoutSave,
  } = useMutation({
    mutationFn: (input: ReplaceProducerProjectCanvasLayoutInput) =>
      replaceProducerProjectCanvasLayout(projectId, input),
  })

  useEffect(() => {
    if (
      fetchStatus !== 'idle' ||
      !isFetchedAfterMount ||
      layoutLoadError ||
      !loadedLayout ||
      (hydratedRevisionRef.current !== null && loadedLayout.revision <= hydratedRevisionRef.current)
    ) {
      return
    }

    const currentState = canvasStore.getState()

    if (
      currentState.layoutHydrated &&
      currentState.layoutCommitVersion > savedCommitVersionRef.current
    ) {
      return
    }

    const acceptedCommitVersion = currentState.layoutCommitVersion

    hydrateLayout(loadedLayout)
    hydratedRevisionRef.current = loadedLayout.revision
    syncWorkspaceNodes(workspaceNodesRef.current)
    savedCommitVersionRef.current = acceptedCommitVersion
  }, [
    canvasStore,
    fetchStatus,
    hydrateLayout,
    isFetchedAfterMount,
    layoutLoadError,
    loadedLayout,
    syncWorkspaceNodes,
  ])

  useEffect(() => {
    if (!layoutHydrated) {
      return
    }

    syncWorkspaceNodes(workspaceNodes)
  }, [layoutHydrated, syncWorkspaceNodes, workspaceNodes])

  const flushLatestLayout = useCallback(async () => {
    if (saveLoopRunningRef.current || !canvasStore.getState().layoutHydrated) {
      return
    }

    saveLoopRunningRef.current = true
    setRecoveryAction(null)

    try {
      while (savedCommitVersionRef.current < canvasStore.getState().layoutCommitVersion) {
        const targetCommitVersion = canvasStore.getState().layoutCommitVersion
        const expectedRevision = hydratedRevisionRef.current

        if (expectedRevision === null) {
          throw new Error('项目画布布局尚未加载，无法保存。')
        }

        const snapshot = canvasStore.getState().getLayoutSnapshot()
        const savedLayout = await saveLayout({
          expectedRevision,
          nodes: snapshot.nodes,
          schemaVersion: snapshot.schemaVersion,
        })

        hydratedRevisionRef.current = savedLayout.revision
        queryClient.setQueryData(queryKey, savedLayout)
        savedCommitVersionRef.current = targetCommitVersion
      }
    } catch (error) {
      setRecoveryAction(
        error instanceof ApiError && error.status === 409 ? 'load-latest' : 'retry-save',
      )
    } finally {
      saveLoopRunningRef.current = false
    }
  }, [canvasStore, queryClient, queryKey, saveLayout])

  useEffect(() => {
    if (!layoutHydrated || recoveryAction || layoutCommitVersion <= savedCommitVersionRef.current) {
      return
    }

    void flushLatestLayout()
  }, [flushLatestLayout, layoutCommitVersion, layoutHydrated, recoveryAction])

  const handleLoadLatestLayout = useCallback(async () => {
    const discardedLayoutSnapshot = canvasStore.getState().getLayoutSnapshot()
    const discardedCommitVersion = canvasStore.getState().layoutCommitVersion
    const result = await refetchLayout()

    if (result.status !== 'success') {
      return
    }

    const currentLayoutSnapshot = canvasStore.getState().getLayoutSnapshot()

    if (hasLayoutEditsSince(discardedLayoutSnapshot.nodes, currentLayoutSnapshot.nodes)) {
      return
    }

    hydrateLayout(result.data)
    hydratedRevisionRef.current = result.data.revision
    syncWorkspaceNodes(workspaceNodesRef.current)
    savedCommitVersionRef.current = discardedCommitVersion
    resetLayoutSave()
    setRecoveryAction(null)
  }, [canvasStore, hydrateLayout, refetchLayout, resetLayoutSave, syncWorkspaceNodes])

  const recoveryMessage =
    recoveryAction === 'load-latest'
      ? layoutLoadError instanceof Error
        ? layoutLoadError.message
        : '画布布局已在其他页面更新'
      : layoutSaveError instanceof Error
        ? layoutSaveError.message
        : '保存项目画布布局失败'

  if (layoutLoadError && !layoutHydrated) {
    throw layoutLoadError
  }

  if (!layoutHydrated) {
    return <RouteBootShell variant="project" />
  }

  return (
    <>
      {children}
      {isSaving || recoveryAction ? (
        <div
          className="layer-popup fixed top-[calc(var(--layout-project-header-height)+var(--layout-project-stage-padding))] right-[var(--layout-project-stage-padding)] flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-popup-bg)] px-3 py-2 text-xs text-[var(--color-on-background)] shadow-[var(--shadow-3)] backdrop-blur-md"
          role={recoveryAction ? 'alert' : 'status'}
        >
          {recoveryAction ? (
            <>
              <span>{recoveryMessage}</span>
              <button
                className="rounded-md bg-[var(--color-control-bg)] px-2 py-1 font-semibold hover:bg-[var(--color-hover)]"
                type="button"
                onClick={() => {
                  if (recoveryAction === 'load-latest') {
                    void handleLoadLatestLayout()
                    return
                  }

                  resetLayoutSave()
                  setRecoveryAction(null)
                  requestLayoutCommit()
                }}
              >
                {recoveryAction === 'load-latest' ? '加载最新布局' : '重试'}
              </button>
            </>
          ) : (
            <span>正在保存画布布局…</span>
          )}
        </div>
      ) : null}
    </>
  )
}
