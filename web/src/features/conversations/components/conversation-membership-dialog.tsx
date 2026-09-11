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
  collectionUnavailable?: string | undefined
  conversation?: Conversation | undefined
  onOpenChange: (open: boolean) => void
  onSaved: () => void
  onRetryCollections?: (() => void) | undefined
  onRetryTasks?: (() => void) | undefined
  open: boolean
  taskOptions: Option[]
  taskUnavailable?: string | undefined
}

/** 合集与需求单归属互相独立，均允许为空。 */
export function ConversationMembershipDialog({
  collectionOptions,
  collectionUnavailable,
  conversation,
  onOpenChange,
  onSaved,
  onRetryCollections,
  onRetryTasks,
  open,
  taskOptions,
  taskUnavailable,
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
            collectionUnavailable={collectionUnavailable}
            conversation={conversation}
            onOpenChange={onOpenChange}
            onSaved={onSaved}
            onRetryCollections={onRetryCollections}
            onRetryTasks={onRetryTasks}
            taskOptions={taskOptions}
            taskUnavailable={taskUnavailable}
          />
        ) : null}
      </DialogSurface>
    </DialogRoot>
  )
}

function MembershipForm({
  collectionOptions,
  collectionUnavailable,
  conversation,
  onOpenChange,
  onSaved,
  onRetryCollections,
  onRetryTasks,
  taskOptions,
  taskUnavailable,
}: Omit<ConversationMembershipDialogProps, 'open'> & { conversation: Conversation }) {
  const [savedConversation, setSavedConversation] = useState(conversation)
  const [collectionId, setCollectionId] = useState(conversation.collectionId ?? NONE)
  const [taskId, setTaskId] = useState(conversation.taskId ?? NONE)
  const saveMutation = useSetConversationMembership(() => {
    toast.success('已保存')
    onSaved()
    onOpenChange(false)
  }, setSavedConversation)

  const collectionChanged =
    !collectionUnavailable && collectionId !== (savedConversation.collectionId ?? NONE)
  const taskChanged = !taskUnavailable && taskId !== (savedConversation.taskId ?? NONE)
  const submit = () => {
    if (saveMutation.isPending || (!collectionChanged && !taskChanged)) return
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
            disabled={Boolean(collectionUnavailable) || saveMutation.isPending}
            onChange={(e) => setCollectionId(e.target.value)}
            value={collectionId}
          >
            <option value={NONE}>不属于任何合集</option>
            {collectionId && !collectionOptions.some((option) => option.id === collectionId) ? (
              <option value={collectionId}>当前关联合集</option>
            ) : null}
            {collectionOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </Select>
          {collectionUnavailable ? (
            <span role="status" className="text-body-sm text-on-surface-variant">
              {collectionUnavailable}
            </span>
          ) : null}
        </label>
        {onRetryCollections ? (
          <Button onClick={onRetryCollections} variant="ghost">
            重新加载合集
          </Button>
        ) : null}
        <label className="flex flex-col gap-2">
          <span className="text-body font-semibold text-on-surface">需求单</span>
          <Select
            aria-label="需求单"
            disabled={Boolean(taskUnavailable) || saveMutation.isPending}
            onChange={(e) => setTaskId(e.target.value)}
            value={taskId}
          >
            <option value={NONE}>不关联需求单</option>
            {taskId && !taskOptions.some((option) => option.id === taskId) ? (
              <option value={taskId}>当前关联需求单</option>
            ) : null}
            {taskOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </Select>
          {taskUnavailable ? (
            <span role="status" className="text-body-sm text-on-surface-variant">
              {taskUnavailable}
            </span>
          ) : null}
        </label>
        {onRetryTasks ? (
          <Button onClick={onRetryTasks} variant="ghost">
            重新加载需求单
          </Button>
        ) : null}
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
