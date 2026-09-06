import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useUser } from '@/shared/auth'
import { ApiError } from '@/shared/api/client'
import { Button } from '@/shared/ui/button'
import {
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogRoot,
  DialogSurface,
} from '@/shared/ui/dialog'
import { toast } from '@/shared/ui/toast'
import {
  claimTask,
  createTask,
  getTask,
  publishTask,
  saveTask,
  tasksQueryKeys,
  withdrawTask,
  type Task,
} from '../tasks.api'
import { TaskStatusTag } from './task-status-tag'
import { TaskFormFields } from './task-form-fields'
import { emptyTaskForm, taskFormOf, type TaskFormState } from './task-form-state'

/** 发布后的创作参数及管理字段，对齐后端冻结规则。 */
const PLANNER_EDITABLE = new Set([
  'title',
  'deadline',
  'creative_requirement',
  'duration_seconds',
  'aspect_ratio',
  'resolution',
  'references',
])

type TaskDialogProps = {
  onOpenChange: (open: boolean) => void
  open: boolean
  /** 有 taskId 时编辑详情，否则新建。 */
  taskId?: string | undefined
}

const toIso = (local: string): string | null => (local ? new Date(local).toISOString() : null)

/** 详情使用完整数据执行 PUT，遗漏字段会被清空；发布后仅管理信息和 PLANNER 字段可编辑，撤回后只读。 */
export function TaskDialog({ onOpenChange, open, taskId }: TaskDialogProps) {
  const isCreate = taskId === undefined
  const {
    data: task,
    error,
    refetch,
  } = useQuery({
    enabled: open && !isCreate,
    queryFn: () => getTask(taskId ?? ''),
    queryKey: tasksQueryKeys.detail(taskId ?? ''),
  })

  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogSurface
        className="task-form-dialog"
        aria-label={isCreate ? '新建需求单' : '需求单详情'}
      >
        <DialogHeader
          actions={task ? <TaskStatusTag status={task.status} /> : undefined}
          className="h-(--layout-dialog-header-height) items-center border-b-0 px-6 py-0"
          closeLabel="关闭"
          title={isCreate ? '新建需求单' : (task?.title ?? '需求单详情')}
        />
        {open &&
          (isCreate || task ? (
            // 切换需求单或新建模式时重挂表单，以重新初始化 useState。
            <TaskDialogForm key={taskId ?? 'create'} onOpenChange={onOpenChange} task={task} />
          ) : (
            <DialogBody>
              {error ? (
                <div className="flex flex-col items-start gap-3">
                  <p className="text-body-sm text-error" role="alert">
                    {error instanceof ApiError ? error.message : '读取需求单失败，请重试'}
                  </p>
                  <Button onClick={() => void refetch()} variant="outlined">
                    重试
                  </Button>
                </div>
              ) : (
                <p className="text-body-sm text-on-surface-variant">加载中…</p>
              )}
            </DialogBody>
          ))}
      </DialogSurface>
    </DialogRoot>
  )
}

type TaskDialogFormProps = {
  onOpenChange: (open: boolean) => void
  task: Task | undefined
}

function TaskDialogForm({ onOpenChange, task }: TaskDialogFormProps) {
  const isCreate = task === undefined
  const { data: user } = useUser()
  const queryClient = useQueryClient()
  const [form, setForm] = useState<TaskFormState>(() => (task ? taskFormOf(task) : emptyTaskForm()))
  const [uploadingFields, setUploadingFields] = useState<Record<string, boolean>>({})
  const uploading = Object.values(uploadingFields).some(Boolean)

  const invalidateTasks = () => queryClient.invalidateQueries({ queryKey: tasksQueryKeys.all })

  const showError = (error: unknown) => {
    toast.error(error instanceof ApiError ? error.message : '操作失败，请重试')
  }

  const createMutation = useMutation({
    mutationFn: createTask,
    onError: showError,
    onSuccess: () => {
      toast.success('需求单已创建')
      void invalidateTasks()
      onOpenChange(false)
    },
  })

  const saveMutation = useMutation({
    mutationFn: async (body: Parameters<typeof saveTask>[1]) => saveTask(task?.id ?? '', body),
    onError: showError,
    onSuccess: () => {
      toast.success('已保存')
      void invalidateTasks()
      onOpenChange(false)
    },
  })

  const actionMutation = useMutation({
    mutationFn: async (action: 'claim' | 'publish' | 'withdraw') => {
      const id = task?.id ?? ''
      if (action === 'publish') return publishTask(id)
      if (action === 'claim') return claimTask(id)
      return withdrawTask(id)
    },
    onError: showError,
    onSuccess: (_saved, action) => {
      toast.success(action === 'publish' ? '已发布' : action === 'claim' ? '已认领' : '已撤回')
      void invalidateTasks()
      onOpenChange(false)
    },
  })

  const canWrite = Boolean(user?.permissions.includes('tasks:write'))
  const canEditDraft = Boolean(
    user && (user.id === task?.creatorUserId || user.permissions.includes('users:manage')),
  )
  const claimed = Boolean(task && user && task.assigneeUserIds.includes(user.id))

  const editable = (field: string): boolean => {
    if (isCreate) return canWrite
    if (!task || !canWrite) return false
    if (task.status === 'withdrawn') return false
    if (field === 'style_no') return false
    if (task.status === 'draft') return canEditDraft
    return PLANNER_EDITABLE.has(field)
  }

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (uploading || busy || !editable('title')) return
    if (!form.title.trim() || !form.inputs.product.style_no.trim()) {
      toast.error('需求单名称和商品款号必填')
      return
    }
    const body = {
      deadline: toIso(form.deadline),
      inputs: isCreate
        ? {
            ...form.inputs,
            product: { ...form.inputs.product, style_no: form.inputs.product.style_no.trim() },
          }
        : form.inputs,
      title: form.title.trim(),
    }
    if (isCreate) createMutation.mutate(body)
    else saveMutation.mutate({ ...body, priority: task.priority })
  }

  const busy = createMutation.isPending || saveMutation.isPending || actionMutation.isPending
  const hasUnsavedChanges =
    task !== undefined && JSON.stringify(form) !== JSON.stringify(taskFormOf(task))

  return (
    <form className="flex min-h-0 flex-1 flex-col" onSubmit={handleSubmit}>
      <DialogBody className="px-6 pt-2 pb-6">
        <TaskFormFields
          form={form}
          editable={(field) => !busy && editable(field)}
          onChange={setForm}
          onUploadingChange={(field, value) =>
            setUploadingFields((previous) => ({ ...previous, [field]: value }))
          }
        />
      </DialogBody>
      {(isCreate || (task && canWrite)) && (
        <DialogFooter>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {task?.status === 'draft' && canEditDraft && (
              <Button
                loading={actionMutation.isPending}
                disabled={busy || uploading || hasUnsavedChanges}
                onClick={() => actionMutation.mutate('publish')}
                variant="ghost"
              >
                发布
              </Button>
            )}
            {task?.status === 'draft' && canEditDraft && hasUnsavedChanges && (
              <span className="text-caption text-on-surface-variant">先保存修改，再发布</span>
            )}
            {(task?.status === 'published' || (task?.status === 'confirmed' && !claimed)) && (
              <Button
                loading={actionMutation.isPending}
                disabled={busy || uploading}
                onClick={() => actionMutation.mutate('claim')}
                variant="ghost"
              >
                认领
              </Button>
            )}
            {(task?.status === 'published' || task?.status === 'confirmed') && (
              <Button
                loading={actionMutation.isPending}
                disabled={busy || uploading}
                onClick={() => actionMutation.mutate('withdraw')}
                variant="ghost"
              >
                撤回
              </Button>
            )}
          </div>
          <div className="flex shrink-0 gap-2">
            <Button className="min-w-[74px]" onClick={() => onOpenChange(false)} variant="outlined">
              取消
            </Button>
            {(isCreate || task?.status !== 'withdrawn') && (
              <Button
                className="min-w-[74px]"
                disabled={uploading || busy || !editable('title')}
                loading={createMutation.isPending || saveMutation.isPending}
                type="submit"
              >
                {isCreate ? '创建需求单' : '保存'}
              </Button>
            )}
          </div>
        </DialogFooter>
      )}
    </form>
  )
}
