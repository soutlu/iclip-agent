/**
 * 审批卡（照 kimi 的 appr 系列）：待审批的那一步停在输入框上方，同意或拒绝之后运行才接着走。
 *
 * 卡面复用工具卡那份 display（ADR-0007 决策 5）：审批与工具行看到的是同一次调用，不另设一份
 * 展示合同。只有「同意 / 拒绝」两项，数字键 1 / 2 也能点。
 */

import { useEffect, useState } from 'react'
import { ApiError } from '@/shared/api/client'
import type { ToolCallFrame } from '@/shared/transcript/vendor'
import { Icon } from '@/shared/icons'
import { toast } from '@/shared/ui/toast'
import { respondInteraction } from '../conversations.api'
import { toolCard } from './tool-display'

type ApprovalCardProps = {
  conversationId: string
  interactionId: string
  /** 这张卡对应的那次调用（按 `approvalId` 找到的）；找不到就只画卡不画参数。 */
  frame: ToolCallFrame | undefined
  /** 决定与服务端记的对不上时重拉一次内容。 */
  onRefresh: () => void
}

const DECISION_LABELS = { approved: '已同意', rejected: '已拒绝' } as const

/** 数字键落在输入区里时不算快捷键：用户正在打字。 */
const inEditor = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  target.closest('input, textarea, [contenteditable="true"]') !== null

/**
 * 渲染审批卡。
 *
 * @param props - 组件属性。
 * @param props.conversationId - 哪一段对话。
 * @param props.interactionId - 哪一张卡。
 * @param props.frame - 这张卡对应的那次调用。
 * @param props.onRefresh - 重拉内容。
 * @returns 审批卡。
 */
export function ApprovalCard({
  conversationId,
  frame,
  interactionId,
  onRefresh,
}: ApprovalCardProps) {
  const card = toolCard(frame?.display)
  const [decision, setDecision] = useState<keyof typeof DECISION_LABELS | null>(null)
  const [sending, setSending] = useState(false)
  // 决定发出去之后卡还留在界面上：撤掉它的是服务端那份 pending 集合，不是本地这次点击。
  // 换到下一张卡时这份状态由调用方按 interactionId 打 key 重置，不在这里跟着 prop 清。
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
      {/* 体只有一句话：这一步做什么已经在头部的 display 里了，原始参数是协议内部形状，不上界面。 */}
      <p className="px-4 pt-3 text-body text-chat-message-text">这一步要你点头才会继续</p>
      <footer className="mt-3 flex flex-col gap-1 border-t-[0.5px] border-chat-hairline px-4 py-3">
        {settled ? (
          <p className="flex items-center gap-1 text-body-sm text-chat-muted-text">
            <Icon decorative name="check" size="sm" />
            {DECISION_LABELS[decision]}
          </p>
        ) : (
          <>
            <ApprovalOption disabled={sending} onSelect={() => decide(true)} shortcut="1">
              同意
            </ApprovalOption>
            <ApprovalOption disabled={sending} onSelect={() => decide(false)} shortcut="2">
              拒绝
            </ApprovalOption>
          </>
        )}
      </footer>
    </section>
  )
}

/**
 * 一个选项：整行左对齐，前面一个数字键小方块。
 *
 * @param props - 组件属性。
 * @param props.children - 选项文案。
 * @param props.shortcut - 对应的数字键。
 * @param props.disabled - 请求在飞时不给再点。
 * @param props.onSelect - 选中。
 * @returns 选项按钮。
 */
function ApprovalOption({
  children,
  disabled,
  onSelect,
  shortcut,
}: {
  children: string
  shortcut: string
  disabled: boolean
  onSelect: () => void
}) {
  return (
    <button
      className="flex w-full ui-state cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-body text-chat-message-text ui-focus"
      disabled={disabled}
      onClick={onSelect}
      type="button"
    >
      <span className="grid size-4 shrink-0 place-items-center rounded-xs bg-chat-chip-bg text-caption text-chat-muted-text">
        {shortcut}
      </span>
      {children}
    </button>
  )
}
