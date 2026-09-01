/**
 * 会话页的输入框。发送、清空、失败把内容还回来，都在这里；气泡由页面那一层管。
 *
 * 附件入口只在有 assets:write 权限时给（kimi：上传不可用就不出这个入口）。
 */

import { useRef, useState } from 'react'
import { useUser } from '@/shared/auth'
import type { ComposerHandle, ComposerSubmission } from '@/shared/ui/composer'
import { Composer } from '@/shared/ui/composer'
import { toast } from '@/shared/ui/toast'
import { ContextUsageIndicator } from './context-usage-indicator'

type ConversationComposerProps = {
  /** 发一条。抛异常表示没送到，这里会把内容还回输入框。 */
  onSend: (text: string, media: ComposerSubmission['media']) => Promise<void>
  /** 这段对话正在跑：发送钮换成停止钮。 */
  busy?: boolean
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
 * @param props.onStop - 点停止。
 * @returns 输入框。
 */
export function ConversationComposer({
  busy = false,
  contextTokens,
  maxContextTokens,
  onSend,
  onStop,
}: ConversationComposerProps) {
  const composerRef = useRef<ComposerHandle>(null)
  const [sending, setSending] = useState(false)
  const { data: user } = useUser()

  const send = async (submission: ComposerSubmission) => {
    composerRef.current?.clear()
    setSending(true)
    try {
      await onSend(submission.text, submission.media)
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
      placeholder="接着说…"
      ref={composerRef}
      sending={sending}
      trailing={
        contextTokens !== undefined && maxContextTokens !== undefined && maxContextTokens > 0 ? (
          <ContextUsageIndicator max={maxContextTokens} used={contextTokens} />
        ) : undefined
      }
    />
  )
}
