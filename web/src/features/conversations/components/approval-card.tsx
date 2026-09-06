/** 审批与工具卡共用 display 合同（ADR-0007 决策 5）；两个正式按钮，数字键 1 / 2 是快捷方式。 */

import { useEffect, useState } from 'react'
import { ApiError } from '@/shared/api/client'
import type { ToolCallFrame } from '@/shared/transcript/vendor'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { toast } from '@/shared/ui/toast'
import { respondInteraction } from '../conversations.api'
import { fileChangeOf, toolCard, type FileChange } from './tool-display'

type ApprovalCardProps = {
  conversationId: string
  interactionId: string
  /** 按 approvalId 匹配调用；未匹配时省略参数。 */
  frame: ToolCallFrame | undefined
  /** 决定与服务端状态冲突时刷新内容。 */
  onRefresh: () => void
}

const DECISION_LABELS = { approved: '已同意', rejected: '已拒绝' } as const

/** 数字键落在输入区里时不算快捷键：用户正在打字。 */
const inEditor = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  target.closest('input, textarea, [contenteditable="true"]') !== null

export function ApprovalCard({
  conversationId,
  frame,
  interactionId,
  onRefresh,
}: ApprovalCardProps) {
  const card = toolCard(frame?.display, frame?.view)
  const change = fileChangeOf(frame?.display)
  const [decision, setDecision] = useState<keyof typeof DECISION_LABELS | null>(null)
  const [sending, setSending] = useState(false)
  // 卡片移除由服务端 pending 集合决定；interactionId 变化时由父组件 key 重置本地决定。
  const settled = decision !== null

  const respond = async (approved: boolean) => {
    setSending(true)
    try {
      await respondInteraction(conversationId, interactionId, approved)
      setDecision(approved ? 'approved' : 'rejected')
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        toast.error('已经做过决定')
        onRefresh()
      } else if (error instanceof ApiError && error.status === 404) {
        toast.error('这张卡已经不在等了')
      } else {
        toast.error(error instanceof Error ? error.message : '提交决定失败')
      }
    } finally {
      setSending(false)
    }
  }

  const decide = (approved: boolean) => {
    if (settled || sending) return
    void respond(approved)
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '1' && event.key !== '2') return
      if (inEditor(event.target)) return
      decide(event.key === '1')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  return (
    <section
      aria-label="等你审批"
      className="mb-2 flex animate-in flex-col rounded-lg border-[0.5px] border-chat-hairline bg-chat-card-bg shadow-[var(--shadow-2)] duration-(--dur-m) ease-(--ease-decel) fade-in slide-in-from-bottom-2"
    >
      <header className="flex min-w-0 items-baseline gap-2 px-4 pt-3">
        <h2 className="shrink-0 text-body font-medium text-chat-message-text">{card.label}</h2>
        {card.detail === undefined ? null : (
          <p className="min-w-0 truncate font-mono text-body-sm text-chat-muted-text">
            {card.detail}
          </p>
        )}
      </header>
      {/* display 提供操作说明与可预览的改动，内部参数不进入审批正文。 */}
      {change === undefined ? null : <ChangePreview change={change} />}
      <p className="px-4 pt-3 text-body text-chat-message-text">这一步要你点头才会继续</p>
      <footer className="mt-3 flex items-center justify-between gap-3 border-t-[0.5px] border-chat-hairline px-4 py-3">
        {settled ? (
          <p className="flex items-center gap-1 text-body-sm text-chat-muted-text">
            <Icon decorative name="check" size="sm" />
            {DECISION_LABELS[decision]}
          </p>
        ) : (
          <>
            <p className="text-caption text-chat-muted-text">按 1 同意，按 2 拒绝</p>
            <div className="flex items-center gap-2">
              <Button
                disabled={sending}
                onClick={() => decide(false)}
                size="md"
                type="button"
                variant="outlined"
              >
                拒绝
              </Button>
              <Button disabled={sending} onClick={() => decide(true)} size="md" type="button">
                同意
              </Button>
            </div>
          </>
        )}
      </footer>
    </section>
  )
}

/** 编辑给前后对照，写入给整份内容；都最多显示十来行，看全貌不是审批卡的事。 */
function ChangePreview({ change }: { change: FileChange }) {
  // 同一段里可能有相同的行，key 用「哪一段的第几行」；序号在这里算好，不在渲染时取下标。
  const block = (text: string, tone: 'plain' | 'removed' | 'added') =>
    text.split('\n').map((line, index) => ({ id: `${tone}-${index}`, text: line, tone }))
  const lines =
    'content' in change
      ? block(change.content, 'plain')
      : [...block(change.before, 'removed'), ...block(change.after, 'added')]
  return (
    <div
      aria-label="改动预览"
      className="mx-4 mt-3 max-h-56 overflow-auto rounded-sm border-[0.5px] border-chat-hairline bg-chat-code-block-bg py-1.5 font-mono text-body-sm"
      role="region"
    >
      {lines.map((line) => (
        <div
          className={cn(
            'px-3 whitespace-pre-wrap',
            line.tone === 'removed' && 'bg-error-container text-on-error-container line-through',
            line.tone === 'added' && 'bg-primary-container text-on-primary-container',
            line.tone === 'plain' && 'text-chat-message-text',
          )}
          key={line.id}
        >
          {line.text === '' ? ' ' : line.text}
        </div>
      ))}
    </div>
  )
}
