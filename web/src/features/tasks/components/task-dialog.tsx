import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef, useState, type ReactNode } from 'react'
import { hasPermission, PERMISSION, useUser } from '@/shared/auth'
import { errorMessageOf } from '@/shared/api/client'
import { Button, IconButton } from '@/shared/ui/button'
import { cn } from '@/shared/lib/utils'
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
import {
  buildTaskCreationDraft,
  type TaskCreationDraft,
  type TaskCreationStarter,
} from '../task-creation'
import {
  canEditTaskField,
  canManageDraft,
  creationBlockReason,
  type TaskField,
} from '../task-permissions'
import { TaskCreationPreview } from './task-creation-preview'
import { TaskStatusTag } from './task-status-tag'
import { TaskFormFields } from './task-form-fields'
import { emptyTaskForm, taskFormOf, type TaskFormState } from './task-form-state'

type TaskDialogProps = {
  relatedContent?: ((taskId: string) => ReactNode) | undefined
  creation?: TaskCreationStarter | undefined
  onOpenChange: (open: boolean) => void
  open: boolean
  /** 有 taskId 时编辑详情，否则新建。 */
  taskId?: string | undefined
}

const toIso = (local: string): string | null => (local ? new Date(local).toISOString() : null)

/** 详情使用完整数据执行 PUT，遗漏字段会被清空；发布后仅管理信息和 PLANNER 字段可编辑，撤回后只读。 */
export function TaskDialog({
  creation,
  relatedContent,
  onOpenChange,
  open,
  taskId,
}: TaskDialogProps) {
  const isCreate = taskId === undefined
  const { data: currentUser } = useUser()
  const [creationDraft, setCreationDraft] = useState<TaskCreationDraft | null>(null)
  const [sending, setSending] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const [closedRelatedTask, setClosedRelatedTask] = useState<string | null>(null)
  const sendingRef = useRef(false)
  const changeOpen = (next: boolean) => {
    if (sendingRef.current) return
    if (!next) {
      setCreationDraft(null)
      setStartError(null)
      setClosedRelatedTask(null)
    }
    onOpenChange(next)
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
  const startCreation = async (agentId: string) => {
    if (!creation || !creationDraft || sendingRef.current) return
    sendingRef.current = true
    setSending(true)
    setStartError(null)
    try {
      const latest = await refetch({ throwOnError: true })
      const blocked = creationBlockReason(currentUser, latest.data)
      if (blocked) {
        setStartError(blocked)
        return
      }
      await creation.start(creationDraft, agentId)
      setCreationDraft(null)
      onOpenChange(false)
    } catch (cause) {
      setStartError(errorMessageOf(cause, '创作启动失败，请重试'))
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }
  const hasRelated = Boolean(task && relatedContent && !creationDraft)
  const showRelated = hasRelated && closedRelatedTask !== taskId

  return (
    <DialogRoot open={open} onOpenChange={changeOpen}>
      <DialogSurface
        bare={showRelated}
        className={cn(
          creationDraft ? 'task-creation-dialog' : 'task-form-dialog',
          showRelated && 'task-detail-dialog',
        )}
        aria-label={creationDraft ? '发起创作' : isCreate ? '新建需求单' : '需求单详情'}
      >
        <div className={cn('task-detail-layout', showRelated && 'task-detail-layout-expanded')}>
          <div className="task-detail-main">
            <DialogHeader
              actions={
                task && !creationDraft ? (
                  <>
                    {hasRelated && !showRelated && (
                      <IconButton
                        label="打开关联对话与视频"
                        name="panel-right"
                        size="sm"
                        onClick={() => setClosedRelatedTask(null)}
                      />
                    )}
                    <TaskStatusTag appearance="dot" status={task.status} />
                  </>
                ) : undefined
              }
              className="min-h-16 items-center border-b-border/60 px-6 py-3"
              closeLabel="关闭"
              title={
                creationDraft ? '发起创作' : isCreate ? '新建需求单' : (task?.title ?? '需求单详情')
              }
            />
            {open &&
              (creationDraft && creation ? (
                <TaskCreationPreview
                  agents={creation.agents}
                  draft={creationDraft}
                  error={startError}
                  blockedReason={creationBlockReason(currentUser, task)}
                  sending={sending}
                  onBack={() => {
                    setCreationDraft(null)
                    setStartError(null)
                  }}
                  onConfirm={(agentId) => void startCreation(agentId)}
                />
              ) : isCreate || task ? (
                // 切换需求单或新建模式时重挂表单，以重新初始化 useState。
                <TaskDialogForm
                  key={taskId ?? 'create'}
                  onOpenChange={changeOpen}
                  task={task}
                  onPreview={
                    creation
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
                        {errorMessageOf(error, '读取需求单失败，请重试')}
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
          </div>
          {open && showRelated && task && (
            <aside aria-label="关联对话与视频" className="task-related-panel">
              <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border/60 px-6 py-3">
                <h2 className="text-title-lg font-semibold">关联对话与视频</h2>
                <IconButton
                  label="收起关联对话与视频"
                  name="close"
                  size="md"
                  onClick={() => setClosedRelatedTask(task.id)}
                />
              </header>
              <div className="task-related-body px-6 pb-6">{relatedContent?.(task.id)}</div>
            </aside>
          )}
        </div>
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
    toast.error(errorMessageOf(error, '操作失败，请重试'))
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

  const canWrite = hasPermission(user, PERMISSION.tasksWrite)
  const claimed = Boolean(task && user && task.assigneeUserIds.includes(user.id))
  const canStartCreation = onPreview !== undefined && creationBlockReason(user, task) === null
  const draft = task ? buildTaskCreationDraft(task) : null

  const editable = (field: TaskField): boolean =>
    isCreate ? canWrite : canEditTaskField(user, task, field)

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
      <DialogBody className="px-6 pt-3 pb-5">
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
            {task?.status === 'draft' && canManageDraft(user, task) && (
              <Button
                loading={actionMutation.isPending}
                disabled={busy || uploading || hasUnsavedChanges}
                onClick={() => actionMutation.mutate('publish')}
                variant="ghost"
              >
                发布
              </Button>
            )}
            {task?.status === 'draft' && canManageDraft(user, task) && hasUnsavedChanges && (
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
            {(isCreate || editable('title')) && (
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
