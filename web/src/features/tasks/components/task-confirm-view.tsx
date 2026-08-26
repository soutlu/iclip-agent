import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { ArrowRight, Bug, Check } from 'lucide-react'
import { useState } from 'react'
import { createConversation, MAX_CONVERSATION_TITLE_CHARS } from '@/features/conversations'
import { confirmVideoTask, VIDEO_TASKS_QUERY_KEY } from '@/features/tasks/api/video-task.api'
import type { VideoTask } from '@/features/tasks/video-task.types'
import type { SettingsChoiceOption } from '@/shared/composer'
import { STORYBOARD_AGENT } from '@/shared/config/agui-target'
import { briefDisplayValue } from './task-display'
import TaskMaterialsEditor from './task-materials-editor'
import TaskOptionDropdown from './task-option-dropdown'
import TaskTable from './task-table'
import { useVideoTasksSnapshot } from './use-video-tasks-snapshot'

const ALL_VALUE = '__all__'

/**
 * 从任务集合提炼一个筛选维度的候选项（含“全部”）。
 *
 * @param values - 该维度出现过的原始值。
 * @param allLabel - “全部”文案。
 * @returns 去重后的下拉选项。
 */
const createFilterOptions = (
  values: readonly string[],
  allLabel: string,
): SettingsChoiceOption[] => [
  { label: allLabel, value: ALL_VALUE },
  ...Array.from(new Set(values.filter(Boolean))).map((value) => ({
    label: briefDisplayValue(value),
    value,
  })),
]

/**
 * 策划师视角：筛选已下发任务、确认接单并进入 Storyboard。
 *
 * @returns 带筛选条与确认动作的任务列表。
 */
export default function TaskConfirmView() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [departmentFilter, setDepartmentFilter] = useState(ALL_VALUE)
  const [requesterFilter, setRequesterFilter] = useState(ALL_VALUE)
  const [brandFilter, setBrandFilter] = useState(ALL_VALUE)
  const { errorMessage, isLoading, snapshot } = useVideoTasksSnapshot()
  const confirmMutation = useMutation({
    mutationFn: (task: VideoTask) => confirmVideoTask(task.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: VIDEO_TASKS_QUERY_KEY })
    },
  })
  // 开始运行 = 为这张单开一段 storyboard 对话（一次尝试），然后进这张单的工作台。
  const startStoryboardMutation = useMutation({
    mutationFn: async (task: VideoTask) => {
      const conversation = await createConversation({
        agentId: STORYBOARD_AGENT.id,
        taskId: task.id,
        title: task.title.slice(0, MAX_CONVERSATION_TITLE_CHARS),
      })
      return { conversation, task }
    },
    // 带上刚开的那次：这张单可能已经跑过好几次（调试页跑的也算），不指名就不知道看哪次。
    onSuccess: async ({ conversation, task }) => {
      await navigate({
        params: { taskId: task.id },
        search: { attempt: conversation.id },
        to: '/storyboards/$taskId',
      })
    },
  })

  const inbox = snapshot.tasks.filter(
    (task) => task.status === 'published' || task.status === 'confirmed',
  )
  const filtered = inbox.filter(
    (task) =>
      (departmentFilter === ALL_VALUE || task.brief.department === departmentFilter) &&
      (requesterFilter === ALL_VALUE || task.brief.requester === requesterFilter) &&
      (brandFilter === ALL_VALUE || task.style.brand === brandFilter),
  )

  return (
    <>
      <div aria-label="任务筛选" className="home-task-confirm-filters" role="group">
        <div className="home-task-confirm-filter">
          <span className="home-task-key-element-label">部门</span>
          <TaskOptionDropdown
            label="按部门筛选"
            name="departmentFilter"
            options={createFilterOptions(
              inbox.map((task) => task.brief.department ?? ''),
              '全部部门',
            )}
            value={departmentFilter}
            onValueChange={setDepartmentFilter}
          />
        </div>
        <div className="home-task-confirm-filter">
          <span className="home-task-key-element-label">需求人</span>
          <TaskOptionDropdown
            label="按需求人筛选"
            name="requesterFilter"
            options={createFilterOptions(
              inbox.map((task) => task.brief.requester ?? ''),
              '全部需求人',
            )}
            value={requesterFilter}
            onValueChange={setRequesterFilter}
          />
        </div>
        <div className="home-task-confirm-filter">
          <span className="home-task-key-element-label">品牌</span>
          <TaskOptionDropdown
            label="按品牌筛选"
            name="brandFilter"
            options={createFilterOptions(
              inbox.map((task) => task.style.brand),
              '全部品牌',
            )}
            value={brandFilter}
            onValueChange={setBrandFilter}
          />
        </div>
      </div>

      <TaskTable
        emptyMessage="暂无待确认任务。"
        errorMessage={errorMessage}
        loading={isLoading}
        renderActions={(task) => (
          <>
            {confirmMutation.variables?.id === task.id && confirmMutation.error ? (
              <p className="home-task-start-error" role="alert">
                {confirmMutation.error.message}
              </p>
            ) : null}
            {startStoryboardMutation.variables?.id === task.id && startStoryboardMutation.error ? (
              <p className="home-task-start-error" role="alert">
                {startStoryboardMutation.error.message}
              </p>
            ) : null}
            {task.status === 'published' ? (
              <button
                className="home-task-start-button"
                disabled={confirmMutation.isPending}
                type="button"
                onClick={() => confirmMutation.mutate(task)}
              >
                <span>
                  {confirmMutation.isPending && confirmMutation.variables?.id === task.id
                    ? '正在确认…'
                    : '确认任务'}
                </span>
                <Check aria-hidden="true" size={15} strokeWidth={2} />
              </button>
            ) : (
              <>
                <button
                  className="home-task-start-button"
                  disabled={startStoryboardMutation.isPending}
                  type="button"
                  onClick={() => startStoryboardMutation.mutate(task)}
                >
                  <span>
                    {startStoryboardMutation.isPending &&
                    startStoryboardMutation.variables?.id === task.id
                      ? '正在进入…'
                      : '进入 Storyboard'}
                  </span>
                  <ArrowRight aria-hidden="true" size={15} strokeWidth={1.8} />
                </button>
                <Link
                  className="home-task-start-button"
                  search={{ taskId: task.id }}
                  to="/storyboard-debug"
                >
                  <span>调试运行</span>
                  <Bug aria-hidden="true" size={15} strokeWidth={1.8} />
                </Link>
              </>
            )}
          </>
        )}
        renderMaterials={(task, confirmation) => (
          // key 绑定 updatedAt：保存成功拉回新任务后重建编辑器，选中态与上传队列随之复位。
          <TaskMaterialsEditor
            assetsById={snapshot.assetsById}
            confirmation={confirmation}
            key={`${task.id}:${task.updatedAt ?? ''}`}
            task={task}
          />
        )}
        snapshot={{ assetsById: snapshot.assetsById, tasks: filtered }}
        variant="confirm"
      />
    </>
  )
}
