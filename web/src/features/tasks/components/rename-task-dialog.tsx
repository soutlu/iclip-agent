import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { ApiError } from '@/shared/api/client'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import {
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogRoot,
  DialogSurface,
} from '@/shared/ui/dialog'
import { Input } from '@/shared/ui/field'
import { toast } from '@/shared/ui/toast'
import { getTask, saveTask, tasksQueryKeys, type Task } from '../tasks.api'

type RenameTaskDialogProps = {
  onOpenChange: (open: boolean) => void
  open: boolean
  /** 要重命名的项目；关闭后保留上一次的值，避免退场动画期间内容闪空 */
  task?: Task | undefined
}

/**
 * 重命名弹窗，样式对齐 WorkBuddy rename-project-dialog：原名称提示 + 新名称输入 + 字数计数。
 *
 * 后端 PUT 是整体覆盖，合同里也没有版本号可比对：提交时重新拉一次全量、只换标题再整份写回，
 * 把覆盖别人改动的窗口缩到「这次拉取到写回」之间，堵不死。
 */
export function RenameTaskDialog({ onOpenChange, open, task }: RenameTaskDialogProps) {
  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogSurface aria-label="重命名项目">
        <DialogHeader
          className="h-(--layout-dialog-header-height) items-center border-b-0 px-6 py-0"
          closeLabel="关闭"
          title={<span className="text-title font-bold">重命名项目</span>}
        />
        {open && task ? <RenameForm key={task.id} onOpenChange={onOpenChange} task={task} /> : null}
      </DialogSurface>
    </DialogRoot>
  )
}

function RenameForm({ onOpenChange, task }: { onOpenChange: (open: boolean) => void; task: Task }) {
  const queryClient = useQueryClient()
  const [name, setName] = useState(task.title)

  const renameMutation = useMutation({
    mutationFn: async (title: string) => {
      const fresh = await getTask(task.id)
      return saveTask(task.id, {
        brief: fresh.brief,
        deadline: fresh.deadline,
        priority: fresh.priority,
        title,
      })
    },
    onError: (error) => {
      toast.error(error instanceof ApiError ? error.message : '重命名失败，请重试')
    },
    onSuccess: () => {
      toast.success('已保存')
      void queryClient.invalidateQueries({ queryKey: tasksQueryKeys.all })
      onOpenChange(false)
    },
  })

  const trimmed = name.trim()
  const atLimit = name.length >= 200
  const submit = () => {
    if (trimmed && trimmed !== task.title) {
      renameMutation.mutate(trimmed)
    }
  }

  return (
    <>
      <DialogBody className="flex flex-col gap-3 px-6 pt-2.5 pb-6">
        <p className="text-body-sm text-on-surface-variant">
          原名称：<span className="font-medium break-all text-on-surface">{task.title}</span>
        </p>
        <div className="flex flex-col gap-1">
          <Input
            aria-label="新的项目名称"
            className="h-(--control-height-sm) rounded-sm border-outline-variant"
            maxLength={200}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit()
            }}
            placeholder="输入新的项目名称"
            value={name}
          />
          <span
            className={cn(
              'self-end text-caption',
              atLimit ? 'text-error' : 'text-on-surface-variant',
            )}
          >
            {name.length}/200
          </span>
        </div>
      </DialogBody>
      <DialogFooter>
        <span />
        <div className="flex gap-2">
          <Button className="min-w-[74px]" onClick={() => onOpenChange(false)} variant="outlined">
            取消
          </Button>
          <Button
            className="min-w-[74px]"
            disabled={!trimmed || trimmed === task.title}
            loading={renameMutation.isPending}
            onClick={submit}
          >
            保存
          </Button>
        </div>
      </DialogFooter>
    </>
  )
}
