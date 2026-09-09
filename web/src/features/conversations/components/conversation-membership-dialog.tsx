import { useState } from 'react'
import { ApiError } from '@/shared/api/client'
import { Button } from '@/shared/ui/button'
import {
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogRoot,
  DialogSurface,
} from '@/shared/ui/dialog'
import { Select } from '@/shared/ui/field'
import { toast } from '@/shared/ui/toast'
import { useSetConversationMembership } from '../conversations.api'

/** select 的空串表示无归属，提交时转换为 null。 */
const NONE = ''

type Option = { id: string; label: string }

type Conversation = {
  collectionId: string | null
  id: string
  taskId: string | null
  title: string
}

type ConversationMembershipDialogProps = {
  /** 候选项由 routes 层注入，避免跨 feature 依赖。 */
  collectionOptions: Option[]
  conversation?: Conversation | undefined
  onOpenChange: (open: boolean) => void
  onSaved: () => void
  open: boolean
  taskOptions: Option[]
}

/** 合集与需求单归属互相独立，均允许为空。 */
export function ConversationMembershipDialog({
  collectionOptions,
  conversation,
  onOpenChange,
  onSaved,
  open,
  taskOptions,
}: ConversationMembershipDialogProps) {
  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogSurface aria-label="对话归属">
        <DialogHeader
          className="h-(--layout-dialog-header-height) items-center border-b-0 px-6 py-0"
          closeLabel="关闭"
          title="对话归属"
        />
        {open && conversation ? (
          <MembershipForm
            key={conversation.id}
            collectionOptions={collectionOptions}
            conversation={conversation}
            onOpenChange={onOpenChange}
            onSaved={onSaved}
            taskOptions={taskOptions}
          />
        ) : null}
      </DialogSurface>
    </DialogRoot>
  )
}

function MembershipForm({
  collectionOptions,
  conversation,
  onOpenChange,
  onSaved,
  taskOptions,
}: Omit<ConversationMembershipDialogProps, 'open'> & { conversation: Conversation }) {
  const [collectionId, setCollectionId] = useState(conversation.collectionId ?? NONE)
  const [taskId, setTaskId] = useState(conversation.taskId ?? NONE)
  const saveMutation = useSetConversationMembership(() => {
    toast.success('已保存')
    onSaved()
    onOpenChange(false)
  })

  const collectionChanged = collectionId !== (conversation.collectionId ?? NONE)
  const taskChanged = taskId !== (conversation.taskId ?? NONE)
  const submit = () => {
    if (!collectionChanged && !taskChanged) return
    saveMutation.mutate(
      {
        conversationId: conversation.id,
        // 仅提交发生变化的归属，避免多余请求。
        ...(collectionChanged ? { collectionId: collectionId || null } : {}),
        ...(taskChanged ? { taskId: taskId || null } : {}),
      },
      {
        onError: (error) => {
          toast.error(error instanceof ApiError ? error.message : '保存失败，请重试')
        },
      },
    )
  }

  return (
    <>
      <DialogBody className="flex flex-col gap-3.5 px-6 pt-2.5 pb-6">
        <p className="text-body-sm break-all text-on-surface-variant">{conversation.title}</p>
        <label className="flex flex-col gap-2">
          <span className="text-body font-semibold text-on-surface">合集</span>
          <Select
            aria-label="合集"
            onChange={(e) => setCollectionId(e.target.value)}
            value={collectionId}
          >
            <option value={NONE}>不属于任何合集</option>
            {collectionOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex flex-col gap-2">
          <span className="text-body font-semibold text-on-surface">需求单</span>
          <Select aria-label="需求单" onChange={(e) => setTaskId(e.target.value)} value={taskId}>
            <option value={NONE}>不关联需求单</option>
            {taskOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </Select>
        </label>
      </DialogBody>
      <DialogFooter>
        <span />
        <div className="flex gap-2">
          <Button className="min-w-[74px]" onClick={() => onOpenChange(false)} variant="outlined">
            取消
          </Button>
          <Button
            className="min-w-[74px]"
            disabled={!collectionChanged && !taskChanged}
            loading={saveMutation.isPending}
            onClick={submit}
          >
            保存
          </Button>
        </div>
      </DialogFooter>
    </>
  )
}
