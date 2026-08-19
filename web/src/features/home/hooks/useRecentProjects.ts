import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  PROJECT_TITLE_MAX_LENGTH,
  type RecentProjectGroup,
  type RecentProjectItem,
} from '@/features/home/utils/create-home.constants'
import {
  createProducerProject,
  type CreateProducerProjectInput,
  listProducerProjects,
  type ProducerProject,
  renameProducerProject,
} from '@/features/projects'

const PROJECT_UPDATED_AT_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  month: 'numeric',
})

/**
 * 规范化首页历史搜索词。
 *
 * @param query - 用户输入的搜索词。
 * @returns 可用于包含匹配的小写搜索词。
 */
const normalizeQuery = (query: string) => query.trim().toLowerCase()

/**
 * 格式化项目更新时间展示文案。
 *
 * @param updatedAt - 后端返回的更新时间；缺失时为 null。
 * @returns 可显示在最近项目列表中的更新时间文案。
 */
const formatProjectUpdatedAt = (updatedAt: null | string) => {
  if (!updatedAt) {
    return '暂无更新时间'
  }

  return PROJECT_UPDATED_AT_FORMATTER.format(new Date(updatedAt))
}

/**
 * 格式化首页项目卡片时间。
 *
 * @param project - 后端返回的项目文件夹。
 * @returns 创建后未编辑显示纯时间；创建后有更新显示 Edit 时间。
 */
const formatProjectCardUpdatedAt = (project: ProducerProject) => {
  const updatedAt = formatProjectUpdatedAt(project.updatedAt)

  if (!project.createdAt || !project.updatedAt) {
    return updatedAt
  }

  return Date.parse(project.createdAt) === Date.parse(project.updatedAt)
    ? updatedAt
    : `Edit ${updatedAt}`
}

/**
 * 把项目文件夹转换成首页项目树列表项。
 *
 * @param project - 后端返回的项目文件夹。
 * @returns 首页项目文件夹列表项。
 */
const projectToRecentProjectItem = (project: ProducerProject): RecentProjectItem => ({
  id: project.id,
  kind: project.kind,
  title: project.title.trim() || '新项目',
  updatedAt: formatProjectCardUpdatedAt(project),
})

/**
 * 按搜索词过滤最近项目树。
 *
 * @param items - 当前项目文件夹列表。
 * @param query - 用户输入的搜索词。
 * @returns 过滤后的项目文件夹列表。
 */
const filterRecentProjectItems = (items: RecentProjectItem[], query: string) => {
  const normalizedQuery = normalizeQuery(query)

  if (!normalizedQuery) {
    return items
  }

  return items.filter((item) => item.title.toLowerCase().includes(normalizedQuery))
}

/**
 * 把可能为空的项目响应收敛为数组。
 *
 * @param projects - 后端项目列表响应。
 * @returns 可安全遍历的项目数组。
 */
const normalizeProducerProjects = (projects: ProducerProject[] | null | undefined) =>
  Array.isArray(projects) ? projects : []

/**
 * 提取项目操作失败时显示给用户的错误文案。
 *
 * @param error - 项目操作流程捕获的未知错误。
 * @param fallbackMessage - 捕获非 Error 值时展示的兜底文案。
 * @returns 可展示在最近项目面板里的错误文案。
 */
const formatProjectActionError = (error: unknown, fallbackMessage: string) =>
  error instanceof Error ? error.message : fallbackMessage

/**
 * 规范化用户输入的项目标题。
 *
 * @param title - 用户在重命名表单里输入的标题。
 * @returns 可提交给后端的项目标题。
 */
const normalizeProjectTitle = (title: string) => title.trim()

/**
 * 管理首页项目文件夹、搜索过滤、重命名和创建状态。
 *
 * @param params - 最近项目查询参数。
 * @param params.query - 用户输入的搜索词。
 * @returns 最近项目分组、加载状态、操作错误和项目操作。
 */
export default function useRecentProjects({ query }: { query: string }) {
  const [projects, setProjects] = useState<ProducerProject[]>([])
  const [projectActionError, setProjectActionError] = useState<null | string>(null)
  const renamingProjectIdsRef = useRef<Set<string>>(new Set())
  const [renamingProjectIds, setRenamingProjectIds] = useState<ReadonlySet<string>>(() => new Set())
  const [isCreatingProject, setIsCreatingProject] = useState(false)
  const [isLoading, setIsLoading] = useState(true)

  /**
   * 读取当前用户的项目文件夹并写入本地列表状态。
   *
   * @param options - 重新加载控制选项。
   * @param options.signal - 用于取消当前请求的 AbortSignal。
   * @param options.updateLoading - 是否同步刷新加载状态。
   * @returns 项目列表刷新完成后的 Promise。
   */
  const reloadProjects = useCallback(
    ({ signal, updateLoading = false }: { signal?: AbortSignal; updateLoading?: boolean } = {}) => {
      if (updateLoading) {
        setIsLoading(true)
      }

      return listProducerProjects({ signal })
        .then((nextProjects) => {
          setProjects(normalizeProducerProjects(nextProjects))
        })
        .catch((error) => {
          if (error instanceof Error && error.name === 'AbortError') {
            return
          }

          setProjects([])
        })
        .finally(() => {
          if (!signal?.aborted && updateLoading) {
            setIsLoading(false)
          }
        })
    },
    [],
  )

  /**
   * 创建项目文件夹，不进入项目页。
   *
   * @param input - 需要创建的项目类型与标题。
   * @returns 创建成功时返回项目文件夹，失败时返回 null。
   */
  const createProject = useCallback(
    async (input: CreateProducerProjectInput) => {
      if (isCreatingProject) {
        return null
      }

      setIsCreatingProject(true)
      setProjectActionError(null)

      try {
        const project = await createProducerProject(input)

        setProjects((currentProjects) => [project, ...currentProjects])
        return project
      } catch (error) {
        setProjectActionError(formatProjectActionError(error, '创建项目失败'))
        return null
      } finally {
        setIsCreatingProject(false)
      }
    },
    [isCreatingProject],
  )

  /**
   * 重命名最近项目并同步更新本地历史列表。
   *
   * @param projectId - 需要重命名的项目文件夹 id。
   * @param title - 用户确认后的新项目标题。
   * @returns 重命名成功时返回 true，失败或输入无效时返回 false。
   */
  const renameProject = useCallback(async (projectId: string, title: string) => {
    const normalizedTitle = normalizeProjectTitle(title)

    if (!normalizedTitle) {
      setProjectActionError('项目名称不能为空')
      return false
    }

    if (normalizedTitle.length > PROJECT_TITLE_MAX_LENGTH) {
      setProjectActionError(`项目名称不能超过 ${PROJECT_TITLE_MAX_LENGTH} 个字符`)
      return false
    }

    if (renamingProjectIdsRef.current.has(projectId)) {
      return false
    }

    renamingProjectIdsRef.current.add(projectId)
    setProjectActionError(null)
    setRenamingProjectIds(new Set(renamingProjectIdsRef.current))

    try {
      const renamedProject = await renameProducerProject(projectId, normalizedTitle)
      setProjects((currentProjects) =>
        currentProjects.map((project) =>
          project.id === projectId
            ? {
                ...project,
                title: renamedProject.title,
                updatedAt: renamedProject.updatedAt ?? project.updatedAt,
              }
            : project,
        ),
      )
      return true
    } catch (error) {
      setProjectActionError(formatProjectActionError(error, '重命名项目失败'))
      return false
    } finally {
      renamingProjectIdsRef.current.delete(projectId)
      setRenamingProjectIds(new Set(renamingProjectIdsRef.current))
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()

    void reloadProjects({ signal: controller.signal, updateLoading: true })

    return () => {
      controller.abort()
    }
  }, [reloadProjects])

  useEffect(() => {
    let controller: AbortController | null = null

    /**
     * 页面重新可见时刷新项目文件夹列表。
     *
     * @returns 无返回值。
     */
    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') {
        return
      }

      controller?.abort()
      controller = new AbortController()
      void reloadProjects({ signal: controller.signal })
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      controller?.abort()
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [reloadProjects])

  const groups = useMemo<RecentProjectGroup[]>(() => {
    const items = filterRecentProjectItems(
      normalizeProducerProjects(projects).map(projectToRecentProjectItem),
      query,
    )

    return items.length > 0
      ? [
          {
            items,
            label: '项目',
          },
        ]
      : []
  }, [projects, query])

  return {
    createProject,
    groups,
    isCreatingProject,
    isLoading,
    projectActionError,
    reloadProjects,
    renameProject,
    renamingProjectIds,
  }
}
