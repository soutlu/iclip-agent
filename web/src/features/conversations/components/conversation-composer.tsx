/**
 * 会话页的输入框。发送、清空、失败把内容还回来，都在这里；气泡由页面那一层管。
 *
 * 附件入口只在有 assets:write 权限时给（kimi：上传不可用就不出这个入口）。
 *
 * 工作台里选中的组 / 帧经 `useWorkbenchSelection` 到这里：画成编辑区上方的引用芯片，发送时把每条
 * 的 `prefix` 一行一条拼在正文前面（ADR-0009 决策 6，不设结构化消息类型）。
 */

import { useEffect, useRef, useState } from 'react'
import { useUser } from '@/shared/auth'
import type { ComposerHandle, ComposerSubmission } from '@/shared/ui/composer'
import { Composer } from '@/shared/ui/composer'
import { toast } from '@/shared/ui/toast'
import { useWorkbenchSelection } from '@/shared/workbench'
import { ContextUsageIndicator } from './context-usage-indicator'

type ConversationComposerProps = {
  /** 发一条：文字与附件按输入框顺序交替的那份。抛异常表示没送到，这里会把内容还回输入框。 */
  onSend: (parts: ComposerSubmission['parts']) => Promise<void>
  /** 这段对话正在跑：发送钮换成停止钮。 */
  busy?: boolean
  /** 有一步等着审批：占位文案换成等审批，说清此刻在等谁。 */
  awaitingApproval?: boolean
  contextTokens: number | undefined
  maxContextTokens: number | undefined
  onStop?: (() => void) | undefined
}

/**
 * 渲染会话页输入框。
 *
 * @param props - 组件属性。
 * @param props.onSend - 发送一条消息。
 * @param props.busy - 这段对话是否正在跑。
 * @param props.awaitingApproval - 是否有一步等着审批。
 * @param props.onStop - 点停止。
 * @returns 输入框。
 */
export function ConversationComposer({
  awaitingApproval = false,
  busy = false,
  contextTokens,
  maxContextTokens,
  onSend,
  onStop,
}: ConversationComposerProps) {
  const composerRef = useRef<ComposerHandle>(null)
  const [sending, setSending] = useState(false)
  const { data: user } = useUser()
  const selection = useWorkbenchSelection()

  // 用户在工作台点了「在聊天里说」：光标落到输入框，接着说就行。
  const { focusToken } = selection
  useEffect(() => {
    if (focusToken > 0) composerRef.current?.focus()
  }, [focusToken])

  const send = async (submission: ComposerSubmission) => {
    composerRef.current?.clear()
    setSending(true)
    const prefix = selection.refs.map((reference) => reference.prefix).join('\n')
    // 引用那几行拼在第一段文字前面；第一段就是图的话，单独成一段文字放最前
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
      // 没送到就把内容还给输入框，用户接着改或者再发一次。
      composerRef.current?.restore(submission)
      toast.error(error instanceof Error ? error.message : '发送失败')
    } finally {
      setSending(false)
    }
  }

  return (
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
  )
}
