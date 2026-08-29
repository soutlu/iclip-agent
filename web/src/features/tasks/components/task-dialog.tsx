import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import type { z } from 'zod'
import { useUser } from '@/shared/auth'
import { ApiError } from '@/shared/api/client'
import type { zTaskBrief } from '@/shared/api/generated/zod.gen'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import {
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogRoot,
  DialogSurface,
} from '@/shared/ui/dialog'
import { Input, Select, Textarea } from '@/shared/ui/field'
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

type Brief = z.output<typeof zTaskBrief>

/** 发布之后仍能改的字段（对齐后端 PLANNER_FIELDS + 管理信息）。 */
const PLANNER_EDITABLE = new Set([
  'title',
  'deadline',
  'requirementDescription',
  'durationSeconds',
  'ratio',
])

const RATIO_OPTIONS = ['1:1', '3:4', '4:3', '9:16', '16:9', '21:9'] as const

/** 复刻 WorkBuddy 弹窗的紧凑字段外观（34px 高、8px 圆角、发丝边框）；全局字段契约不动，只收在这个弹窗里。 */
const COMPACT_FIELD = 'h-(--control-height-sm) rounded-sm border-outline-variant'

/** 行内控件：剥掉共享字段自己的框（行本身就是框），文字右对齐、聚焦时显出主色描边。 */
const ROW_CONTROL =
  'h-8 w-full min-w-0 flex-1 rounded-none border-transparent bg-transparent px-0 text-right disabled:cursor-not-allowed disabled:text-disabled-text'

type TaskDialogProps = {
  onOpenChange: (open: boolean) => void
  open: boolean
  /** 传了就是详情/补充模式，不传就是新建模式 */
  taskId?: string | undefined
}

type FormState = {
  title: string
  styleNo: string
  deadline: string
  requirementDescription: string
  theme: string
  durationSeconds: string
  ratio: string
}

const EMPTY_FORM: FormState = {
  deadline: '',
  durationSeconds: '',
  ratio: '',
  requirementDescription: '',
  styleNo: '',
  theme: '',
  title: '',
}

/** datetime-local ↔ ISO。空字符串按「没填」处理成 null。 */
const toLocalInput = (iso: string | null): string => (iso ? iso.slice(0, 16) : '')
const toIso = (local: string): string | null => (local ? new Date(local).toISOString() : null)

const formOf = (task: Task): FormState => ({
  deadline: toLocalInput(task.deadline),
  durationSeconds: task.brief.durationSeconds?.toString() ?? '',
  ratio: task.brief.ratio ?? '',
  requirementDescription: task.brief.requirementDescription,
  styleNo: task.style.styleNo,
  theme: task.brief.theme,
  title: task.title,
})

/**
 * 项目弹窗：新建与详情/补充共用。
 *
 * 详情模式先拉全量再整体 PUT 回去（后端 PUT 是整体覆盖，不带上的字段会被清空）；
 * 可编辑范围随状态收窄：草稿全可改，下发后只剩管理信息与 PLANNER 字段，撤回只读。
 */
export function TaskDialog({ onOpenChange, open, taskId }: TaskDialogProps) {
  const isCreate = taskId === undefined
  const { data: task } = useQuery({
    enabled: open && !isCreate,
    queryFn: () => getTask(taskId ?? ''),
    queryKey: tasksQueryKeys.detail(taskId ?? ''),
  })

  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogSurface aria-label={isCreate ? '新建项目' : '项目详情'}>
        <DialogHeader
          actions={task ? <TaskStatusTag status={task.status} /> : undefined}
          className="h-(--layout-dialog-header-height) items-center border-b-0 px-6 py-0"
          closeLabel="关闭"
          title={isCreate ? '新建项目' : (task?.title ?? '项目详情')}
        />
        {open &&
          (isCreate || task ? (
            // key 保证换单/新建-详情切换时表单整体重挂载，初始值在 useState 里取
            <TaskDialogForm key={taskId ?? 'create'} onOpenChange={onOpenChange} task={task} />
          ) : (
            <DialogBody>
              <p className="text-body-sm text-on-surface-variant">加载中…</p>
            </DialogBody>
          ))}
      </DialogSurface>
    </DialogRoot>
  )
}

type TaskDialogFormProps = {
  onOpenChange: (open: boolean) => void
  /** undefined = 新建模式 */
  task: Task | undefined
}

function TaskDialogForm({ onOpenChange, task }: TaskDialogFormProps) {
  const isCreate = task === undefined
  const { data: user } = useUser()
  const queryClient = useQueryClient()
  const [form, setForm] = useState<FormState>(() => (task ? formOf(task) : EMPTY_FORM))

  const invalidateTasks = () => queryClient.invalidateQueries({ queryKey: tasksQueryKeys.all })

  const showError = (error: unknown) => {
    toast.error(error instanceof ApiError ? error.message : '操作失败，请重试')
  }

  const createMutation = useMutation({
    mutationFn: createTask,
    onError: showError,
    onSuccess: () => {
      toast.success('项目已创建')
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
  const claimed = Boolean(task && user && task.assigneeUserIds.includes(user.id))

  // 可编辑范围：新建全可改；草稿全可改；下发后只放 PLANNER_EDITABLE；撤回全锁。
  const editable = (field: string): boolean => {
    if (isCreate) return true
    if (!task || !canWrite) return false
    if (task.status === 'withdrawn') return false
    if (task.status === 'draft') return true
    return PLANNER_EDITABLE.has(field)
  }

  const patch = (partial: Partial<FormState>) => setForm((prev) => ({ ...prev, ...partial }))

  const handleCreate = () => {
    if (!form.title.trim() || !form.styleNo.trim()) {
      toast.error('标题和主款号必填')
      return
    }
    createMutation.mutate({
      brief: {
        requirementDescription: form.requirementDescription.trim(),
        theme: form.theme.trim(),
      },
      deadline: toIso(form.deadline),
      styleNo: form.styleNo.trim(),
      title: form.title.trim(),
    })
  }

  const handleSave = () => {
    if (!task || !form.title.trim()) {
      toast.error('标题必填')
      return
    }
    // 整体覆盖：以读到的整份为底，只叠上表单里放开的字段，其余原样带回去。
    const brief: Brief = { ...task.brief }
    if (editable('requirementDescription')) {
      brief.requirementDescription = form.requirementDescription.trim()
    }
    if (editable('theme')) brief.theme = form.theme.trim()
    if (editable('durationSeconds')) {
      brief.durationSeconds = form.durationSeconds ? Number(form.durationSeconds) : null
    }
    if (editable('ratio')) {
      brief.ratio = (form.ratio || null) as Brief['ratio']
    }
    saveMutation.mutate({
      brief,
      deadline: editable('deadline') ? toIso(form.deadline) : task.deadline,
      priority: task.priority,
      title: form.title.trim(),
    })
  }

  return (
    <>
      <DialogBody className="px-6 pt-2.5 pb-6">
        <div className="flex flex-col gap-3.5">
          <Field label="项目名称" required>
            <Input
              aria-label="项目名称"
              className={COMPACT_FIELD}
              disabled={!editable('title')}
              maxLength={200}
              onChange={(e) => patch({ title: e.target.value })}
              placeholder="请输入项目名称"
              value={form.title}
            />
            <span
              className={cn(
                'self-end text-caption',
                form.title.length >= 200 ? 'text-error' : 'text-on-surface-variant',
              )}
            >
              {form.title.length}/200
            </span>
          </Field>
          <Field label="需求描述">
            <Textarea
              aria-label="需求描述"
              className="resize-none rounded-sm"
              disabled={!editable('requirementDescription')}
              onChange={(e) => patch({ requirementDescription: e.target.value })}
              placeholder="提供当前项目的背景信息和创作要求，让输出更精准、更符合要求。比如：项目目标、风格偏好、目标受众、输出约束等"
              rows={5}
              value={form.requirementDescription}
            />
          </Field>
          {/* 次要字段学 WorkBuddy 的 ConfigRow：标签在框内左侧、控件无边框靠右，不再每个字段一个外标签+框 */}
          <div className="flex flex-col gap-3.5">
            {isCreate && (
              <RowField label="主款号" required>
                <Input
                  aria-label="主款号"
                  className={ROW_CONTROL}
                  onChange={(e) => patch({ styleNo: e.target.value })}
                  placeholder="例如 SBPU24001W"
                  value={form.styleNo}
                />
              </RowField>
            )}
            <RowField label="主题">
              <Input
                aria-label="主题"
                className={ROW_CONTROL}
                disabled={!editable('theme')}
                onChange={(e) => patch({ theme: e.target.value })}
                placeholder="选填"
                value={form.theme}
              />
            </RowField>
            <RowField label="时长（秒，3–50）">
              <Input
                aria-label="时长"
                className={ROW_CONTROL}
                disabled={!editable('durationSeconds')}
                inputMode="numeric"
                onChange={(e) => patch({ durationSeconds: e.target.value })}
                placeholder="选填"
                value={form.durationSeconds}
              />
            </RowField>
            <RowField label="画幅">
              <Select
                aria-label="画幅"
                className={cn(ROW_CONTROL, 'w-auto flex-none')}
                disabled={!editable('ratio')}
                onChange={(e) => patch({ ratio: e.target.value })}
                value={form.ratio}
              >
                <option value="">未指定</option>
                {RATIO_OPTIONS.map((ratio) => (
                  <option key={ratio} value={ratio}>
                    {ratio}
                  </option>
                ))}
              </Select>
            </RowField>
            <RowField label="截止时间">
              <Input
                aria-label="截止时间"
                className={ROW_CONTROL}
                disabled={!editable('deadline')}
                onChange={(e) => patch({ deadline: e.target.value })}
                type="datetime-local"
                value={form.deadline}
              />
            </RowField>
          </div>
        </div>
      </DialogBody>
      {(isCreate || (task && canWrite)) && (
        <DialogFooter>
          <div className="flex gap-2">
            {task?.status === 'draft' && (
              <Button
                loading={actionMutation.isPending}
                onClick={() => actionMutation.mutate('publish')}
                variant="ghost"
              >
                发布
              </Button>
            )}
            {(task?.status === 'published' || (task?.status === 'confirmed' && !claimed)) && (
              <Button
                loading={actionMutation.isPending}
                onClick={() => actionMutation.mutate('claim')}
                variant="ghost"
              >
                认领
              </Button>
            )}
            {(task?.status === 'published' || task?.status === 'confirmed') && (
              <Button
                loading={actionMutation.isPending}
                onClick={() => actionMutation.mutate('withdraw')}
                variant="ghost"
              >
                撤回
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button className="min-w-[74px]" onClick={() => onOpenChange(false)} variant="outlined">
              取消
            </Button>
            <Button
              className="min-w-[74px]"
              disabled={!isCreate && !canWrite}
              loading={createMutation.isPending || saveMutation.isPending}
              onClick={isCreate ? handleCreate : handleSave}
            >
              {isCreate ? '确定' : '保存'}
            </Button>
          </div>
        </DialogFooter>
      )}
    </>
  )
}

function Field({
  children,
  label,
  required = false,
}: {
  children: React.ReactNode
  label: string
  required?: boolean
}) {
  return (
    <label className="flex flex-col gap-2">
      <span className="text-body font-semibold text-on-surface">
        {label}
        {required && <span className="text-error"> *</span>}
      </span>
      {children}
    </label>
  )
}

/** WorkBuddy ConfigRow 风格的细行：标签在框内左侧，无边框控件靠右；整行是 label，点行即聚焦控件。 */
function RowField({
  children,
  label,
  required = false,
}: {
  children: React.ReactNode
  label: string
  required?: boolean
}) {
  return (
    <label className="flex min-h-[38px] cursor-text items-center justify-between gap-3 rounded-sm border border-outline-variant px-3">
      <span className="shrink-0 text-body font-semibold text-on-surface">
        {label}
        {required && <span className="text-error"> *</span>}
      </span>
      {children}
    </label>
  )
}
