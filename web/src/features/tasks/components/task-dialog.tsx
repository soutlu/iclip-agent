import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
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
import { buildTaskCreationDraft, type TaskCreationDraft } from '../task-creation'
import { TaskCreationPreview } from './task-creation-preview'
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
  onStartCreation?: ((draft: TaskCreationDraft) => Promise<void>) | undefined
  onOpenChange: (open: boolean) => void
  open: boolean
  /** 有 taskId 时编辑详情，否则新建。 */
  taskId?: string | undefined
}

const toIso = (local: string): string | null => (local ? new Date(local).toISOString() : null)

/** 详情使用完整数据执行 PUT，遗漏字段会被清空；发布后仅管理信息和 PLANNER 字段可编辑，撤回后只读。 */
export function TaskDialog({ onOpenChange, onStartCreation, open, taskId }: TaskDialogProps) {
  const isCreate = taskId === undefined
  const { data: currentUser } = useUser()
  const [creationDraft, setCreationDraft] = useState<TaskCreationDraft | null>(null)
  const [sending, setSending] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const sendingRef = useRef(false)
  const changeOpen = (next: boolean) => {
    if (sendingRef.current) return
    if (!next) {
      setCreationDraft(null)
      setStartError(null)
    }
    onOpenChange(next)
  }
  const creationBlockReason = (latestTask: Task | undefined): string | null => {
    if (!currentUser?.permissions.includes('agent:run')) return '当前账号没有启动创作权限'
    if (!latestTask) return '无法读取需求单，请返回后重试'
    if (latestTask.status === 'withdrawn') return '需求单已撤回，无法开始创作'
    if (latestTask.status !== 'confirmed') return '需求单尚未认领，无法开始创作'
    if (!latestTask.assigneeUserIds.includes(currentUser.id))
      return '你尚未认领这张需求单，无法开始创作'
    return null
  }
  const startCreation = async () => {
    if (!onStartCreation || !creationDraft || sendingRef.current) return
    sendingRef.current = true
    setSending(true)
    setStartError(null)
    try {
      const latest = await refetch({ throwOnError: true })
      const blocked = creationBlockReason(latest.data)
      if (blocked) {
        setStartError(blocked)
        return
      }
      await onStartCreation(creationDraft)
      setCreationDraft(null)
      onOpenChange(false)
    } catch (cause) {
      setStartError(cause instanceof Error ? cause.message : '创作启动失败，请重试')
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }
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
    <DialogRoot open={open} onOpenChange={changeOpen}>
      <DialogSurface
        className={creationDraft ? 'task-creation-dialog' : 'task-form-dialog'}
        aria-label={creationDraft ? '发起创作' : isCreate ? '新建需求单' : '需求单详情'}
      >
        <DialogHeader
          actions={task && !creationDraft ? <TaskStatusTag status={task.status} /> : undefined}
          className="h-(--layout-dialog-header-height) items-center border-b-0 px-6 py-0"
          closeLabel="关闭"
          title={
            creationDraft ? '发起创作' : isCreate ? '新建需求单' : (task?.title ?? '需求单详情')
          }
        />
        {open &&
          (creationDraft ? (
            <TaskCreationPreview
              draft={creationDraft}
              error={startError}
              blockedReason={creationBlockReason(task)}
              sending={sending}
              onBack={() => {
                setCreationDraft(null)
                setStartError(null)
              }}
              onConfirm={() => void startCreation()}
            />
          ) : isCreate || task ? (
            // 切换需求单或新建模式时重挂表单，以重新初始化 useState。
            <TaskDialogForm
              key={taskId ?? 'create'}
              onOpenChange={changeOpen}
              task={task}
              onPreview={
                onStartCreation
                  ? (draft) => {
                      setCreationDraft(draft)
                      setStartError(null)
                    }
                  : undefined
              }
            />
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
  onPreview: ((draft: TaskCreationDraft) => void) | undefined
  onOpenChange: (open: boolean) => void
  task: Task | undefined
}

function TaskDialogForm({ onOpenChange, onPreview, task }: TaskDialogFormProps) {
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
  const canStartCreation = Boolean(
    onPreview && task?.status === 'confirmed' && claimed && user?.permissions.includes('agent:run'),
  )
  const draft = task ? buildTaskCreationDraft(task) : null

  const editable = (field: string): boolean => {
    if (isCreate) return canWrite
    if (!task || !canWrite) return false
    if (task.status === 'withdrawn') return false
    // 款号及其顺序在创建时定下，之后只能改每款的名称、属性和图片。
    if (field === 'style_no' || field === 'products') return false
    if (task.status === 'draft') return canEditDraft
    return PLANNER_EDITABLE.has(field)
  }

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (uploading || busy || !editable('title')) return
    const products = form.inputs.products.map((product) => ({
      ...product,
      style_no: product.style_no.trim(),
    }))
    if (!form.title.trim() || products.some((product) => !product.style_no)) {
      toast.error('需求单名称和商品款号必填')
      return
    }
    if (new Set(products.map((product) => product.style_no)).size !== products.length) {
      toast.error('商品款号不能重复')
      return
    }
    const body = {
      deadline: toIso(form.deadline),
      inputs: isCreate ? { ...form.inputs, products } : form.inputs,
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
          // 上传中不增减商品：图片字段按位置挂载，删一款会让还在传的那一款换位置。
          editable={(field) => !busy && !(field === 'products' && uploading) && editable(field)}
          onChange={setForm}
          onUploadingChange={(field, value) =>
            setUploadingFields((previous) => ({ ...previous, [field]: value }))
          }
        />
      </DialogBody>
      {canStartCreation && (hasUnsavedChanges || uploading || !draft) && (
        <p className="px-6 pb-3 text-body-sm text-on-surface-variant" role="status">
          {uploading
            ? '素材上传中，完成后请先保存'
            : hasUnsavedChanges
              ? '先保存修改，再开始创作'
              : '请补充创作要求、视频规格或参考素材后开始'}
        </p>
      )}
      {(isCreate || (task && (canWrite || canStartCreation))) && (
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
            {canWrite &&
              (task?.status === 'published' || (task?.status === 'confirmed' && !claimed)) && (
                <Button
                  loading={actionMutation.isPending}
                  disabled={busy || uploading}
                  onClick={() => actionMutation.mutate('claim')}
                  variant="ghost"
                >
                  认领
                </Button>
              )}
            {canWrite && (task?.status === 'published' || task?.status === 'confirmed') && (
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
            {!canStartCreation && (
              <Button
                className="min-w-[74px]"
                onClick={() => onOpenChange(false)}
                variant="outlined"
              >
                取消
              </Button>
            )}
            {(isCreate || (canWrite && task?.status !== 'withdrawn')) && (
              <Button
                className="min-w-[74px]"
                disabled={uploading || busy || !editable('title')}
                loading={createMutation.isPending || saveMutation.isPending}
                type="submit"
                variant={canStartCreation ? 'outlined' : 'primary'}
              >
                {isCreate ? '创建需求单' : '保存'}
              </Button>
            )}
            {canStartCreation && (
              <Button
                disabled={busy || uploading || hasUnsavedChanges || !draft}
                trailingIcon="next"
                onClick={() => {
                  if (draft && !hasUnsavedChanges && !uploading) onPreview?.(draft)
                }}
              >
                开始创作
              </Button>
            )}
          </div>
        </DialogFooter>
      )}
    </form>
  )
}
