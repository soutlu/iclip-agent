/** 工作台引用按 prefix 逐行拼到正文前（ADR-0009 决策 6）；附件入口由 assets:write 权限控制。 */

import { useEffect, useRef, useState } from 'react'
import { useUser } from '@/shared/auth'
import type { ComposerHandle, ComposerPart, ComposerSubmission } from '@/shared/ui/composer'
import { Composer } from '@/shared/ui/composer'
import { toast } from '@/shared/ui/toast'
import { useWorkbenchSelection } from '@/shared/workbench'
import { ContextUsageIndicator } from './context-usage-indicator'

type ComposerEditing = {
  ordinal: number
  parts: readonly ComposerPart[]
}

type ConversationComposerProps = {
  /** 按编辑器顺序提交文字与附件；抛错时恢复输入内容。 */
  onSend: (parts: ComposerSubmission['parts']) => Promise<void>
  busy?: boolean
  awaitingApproval?: boolean
  contextTokens: number | undefined
  maxContextTokens: number | undefined
  onStop?: (() => void) | undefined
  /** 修改态替换编辑器内容；退出时由调用方清除 editing。 */
  editing?: ComposerEditing | undefined
  onCancelEdit?: (() => void) | undefined
}

const submissionOf = (parts: readonly ComposerPart[]): ComposerSubmission => ({
  media: parts.flatMap((part) => (part.kind === 'media' ? [part.media] : [])),
  parts,
  text: parts.flatMap((part) => (part.kind === 'text' ? [part.text] : [])).join(''),
})

export function ConversationComposer({
  awaitingApproval = false,
  busy = false,
  contextTokens,
  editing,
  maxContextTokens,
  onCancelEdit,
  onSend,
  onStop,
}: ConversationComposerProps) {
  const composerRef = useRef<ComposerHandle>(null)
  const [sending, setSending] = useState(false)
  const { data: user } = useUser()
  const selection = useWorkbenchSelection()

  const { focusToken } = selection
  useEffect(() => {
    if (focusToken > 0) composerRef.current?.focus()
  }, [focusToken])

  useEffect(() => {
    const handle = composerRef.current
    if (handle === null) return
    if (editing === undefined) {
      handle.clear()
      return
    }
    handle.restore(submissionOf(editing.parts))
    handle.focus()
  }, [editing])

  const send = async (submission: ComposerSubmission) => {
    composerRef.current?.clear()
    setSending(true)
    const prefix = selection.refs.map((reference) => reference.prefix).join('\n')
    // 引用前缀插入首个文字段；首段为媒体时新增前置文字段。
    const [first, ...rest] = submission.parts
    const parts: ComposerSubmission['parts'] =
      prefix === ''
        ? submission.parts
        : first?.kind === 'text'
          ? [{ kind: 'text', text: `${prefix}\n${first.text}` }, ...rest]
          : [{ kind: 'text', text: prefix }, ...submission.parts]
    try {
      await onSend(parts)
      selection.clear()
    } catch (error) {
      composerRef.current?.restore(submission)
      toast.error(error instanceof Error ? error.message : '发送失败')
    } finally {
      setSending(false)
    }
  }

  return (
    <>
      {editing === undefined ? null : (
        <div className="mb-2 flex items-center justify-between rounded-sm border-[0.5px] border-chat-hairline bg-top-layer px-3 py-1.5 text-body-sm text-chat-secondary-text">
          <span>正在修改第 {editing.ordinal} 轮</span>
          <button
            className="cursor-pointer ui-focus ui-motion-s hover:text-chat-message-text"
            onClick={onCancelEdit}
            type="button"
          >
            取消
          </button>
        </div>
      )}
      <Composer
        attachmentsEnabled={user?.permissions.includes('assets:write') ?? false}
        busy={busy}
        dense
        onStop={onStop}
        onSubmit={(submission) => void send(submission)}
        placeholder={awaitingApproval ? '等你审批后继续' : '接着说…'}
        ref={composerRef}
        references={selection.refs.map((reference) => ({
          id: reference.id,
          label: reference.label,
          onRemove: () => selection.remove(reference.id),
        }))}
        sending={sending}
        trailing={
          contextTokens !== undefined && maxContextTokens !== undefined && maxContextTokens > 0 ? (
            <ContextUsageIndicator max={maxContextTokens} used={contextTokens} />
          ) : undefined
        }
      />
    </>
  )
}
