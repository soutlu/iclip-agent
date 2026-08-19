import { useQuery } from '@tanstack/react-query'
import { listVideoTaskSnapshot, VIDEO_TASKS_QUERY_KEY } from '@/features/tasks/api/video-task.api'
import type { VideoTaskSnapshot } from '@/features/tasks/video-task.types'

const EMPTY_SNAPSHOT: VideoTaskSnapshot = { assetsById: {}, tasks: [] }

/**
 * 下发 / 确认两个视图共用的任务快照查询：统一空快照兜底与错误文案推导。
 *
 * @returns 任务快照（加载或失败时为空快照）、加载态与可直接展示的错误文案。
 */
export const useVideoTasksSnapshot = () => {
  const query = useQuery({
    queryFn: listVideoTaskSnapshot,
    queryKey: VIDEO_TASKS_QUERY_KEY,
  })

  return {
    errorMessage: query.error?.message,
    isLoading: query.isLoading,
    snapshot: query.data ?? EMPTY_SNAPSHOT,
  }
}
