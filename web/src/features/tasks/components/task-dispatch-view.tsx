import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { dispatchVideoTask, VIDEO_TASKS_QUERY_KEY } from '@/features/tasks/api/video-task.api'
import { Icon } from '@/shared/icons'
import TaskDispatchForm from './task-dispatch-form'
import TaskTable from './task-table'
import { useVideoTasksSnapshot } from './use-video-tasks-snapshot'

/**
 * 需求方视角：下发新任务并查看全部任务的状态流转。
 *
 * @returns 下发表单入口加任务列表。
 */
export default function TaskDispatchView() {
  const queryClient = useQueryClient()
  const [creating, setCreating] = useState(false)
  const { errorMessage, isLoading, snapshot } = useVideoTasksSnapshot()
  const dispatchMutation = useMutation({
    mutationFn: dispatchVideoTask,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: VIDEO_TASKS_QUERY_KEY })
      setCreating(false)
    },
  })

  const closeCreator = () => {
    if (!dispatchMutation.isPending) {
      setCreating(false)
    }
  }

  return (
    <>
      <div className="home-tasks-heading">
        <button
          aria-expanded={creating}
          className="home-task-primary-action"
          type="button"
          onClick={() => (creating ? closeCreator() : setCreating(true))}
        >
          {creating ? (
            <Icon decorative name="collapse" size="md" />
          ) : (
            <Icon decorative name="add" size="md" />
          )}
          <span>{creating ? '收起' : 'New task'}</span>
        </button>
      </div>

      {creating ? (
        <TaskDispatchForm
          error={dispatchMutation.error}
          submitting={dispatchMutation.isPending}
          onCancel={closeCreator}
          onSubmit={(input) => dispatchMutation.mutate(input)}
        />
      ) : null}

      <TaskTable
        emptyMessage="还没有任务，点击 New task 下发第一条任务。"
        errorMessage={errorMessage}
        loading={isLoading}
        snapshot={snapshot}
        variant="dispatch"
      />
    </>
  )
}
