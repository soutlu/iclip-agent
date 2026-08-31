/**
 * 会话页：一段对话的内容，底下贴着输入框。
 *
 * 内容来自 `useTranscript`——订阅、拉基线、补漏都在它里面，这里只管铺开、滚动与发送。
 */

import { useEffect, useRef, useState } from 'react'
import { useTranscript } from '@/shared/transcript/use-transcript'
import { Icon } from '@/shared/icons'
import { Button } from '@/shared/ui/button'
import { mintPromptId, submitPrompt, useSidebarTopology } from '../conversations.api'
import { ConversationComposer } from './conversation-composer'
import { ConversationTurn, UserBubble } from './conversation-turn'

/** 离底多少像素之内算「还贴着底」，越过就不再自动跟随。照 kimi。 */
const STICK_THRESHOLD_PX = 80

type ConversationRouteProps = {
  conversationId: string
}

type PendingPrompt = {
  promptId: string
  text: string
}

/**
 * 渲染会话页。
 *
 * @param props - 组件属性。
 * @param props.conversationId - 哪一段对话。
 * @returns 会话页内容。
 */
export function ConversationRoute({ conversationId }: ConversationRouteProps) {
  const { view, refresh } = useTranscript(conversationId)
  const title = useConversationTitle(conversationId)
  const [pending, setPending] = useState<readonly PendingPrompt[]>([])

  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const stickingRef = useRef(true)

  useEffect(() => {
    const scroller = scrollerRef.current
    if (scroller === null || !stickingRef.current) return
    scroller.scrollTop = scroller.scrollHeight
  }, [view.items, pending])

  const turns = view.items.filter((item) => item.kind === 'turn')

  // 认领只看 `promptId`：服务端记下这条消息之后会带着同一个 id 回来。排着队的那条时间线上还
  // 没有它那一轮，所以气泡留着；跑起来之后撤掉，交给时间线渲染。
  const claimed = new Set(
    view.prompts.filter((prompt) => prompt.status !== 'queued').map((prompt) => prompt.promptId),
  )
  const bubbles = pending.filter((item) => !claimed.has(item.promptId))

  const send = async (text: string) => {
    const promptId = mintPromptId()
    setPending((list) => [
      ...list.filter((item) => !claimed.has(item.promptId)),
      { promptId, text },
    ])
    try {
      await submitPrompt(conversationId, { promptId, text })
    } catch (error) {
      // 没送到就把气泡撤掉——留着一条永远认领不到的更糟；输入框那边会把字还回去。
      setPending((list) => list.filter((item) => item.promptId !== promptId))
      throw error
    }
  }

  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="flex h-(--layout-project-header-height) shrink-0 items-center px-6">
        <h1 className="truncate text-title-lg text-on-surface">{title}</h1>
      </header>
      <div
        className="min-h-0 flex-1 overflow-y-auto"
        onScroll={(event) => {
          const scroller = event.currentTarget
          const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
          stickingRef.current = distance <= STICK_THRESHOLD_PX
        }}
        ref={scrollerRef}
      >
        <div className="mx-auto flex w-full max-w-(--layout-home-read-max) flex-col gap-4 px-5 pt-2 pb-4">
          {view.status === 'loading' ? (
            <p className="flex items-center gap-2 py-12 text-body-sm text-on-surface-variant">
              <Icon className="animate-spin" decorative name="loading" size="sm" />
              正在读取对话
            </p>
          ) : null}
          {turns.map((turn) => (
            <ConversationTurn key={turn.turnId} turn={turn} />
          ))}
          {bubbles.map((item) => (
            <UserBubble key={item.promptId} text={item.text} />
          ))}
          {view.status === 'ready' && turns.length === 0 && bubbles.length === 0 ? (
            <p className="py-12 text-body-sm text-on-surface-variant">这段对话还没有内容</p>
          ) : null}
          {view.status === 'error' ? (
            <div className="flex flex-col items-start gap-3 py-12">
              <p className="text-body-sm text-on-surface-variant">{view.error}</p>
              <Button leadingIcon="refresh" onClick={refresh} size="md" variant="outlined">
                重新加载
              </Button>
            </div>
          ) : null}
        </div>
      </div>
      <div className="relative shrink-0 px-5 pb-4">
        {/* 输入卡上方一段渐隐：内容滚到卡后面时不会齐刷刷切断（照 kimi 的 chat-dock） */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 -top-12 h-12 bg-gradient-to-b from-transparent to-background"
        />
        <div className="mx-auto w-full max-w-(--layout-home-read-max)">
          <ConversationComposer onSend={send} />
        </div>
      </div>
    </main>
  )
}

/** 标题取侧栏那份拓扑里的（侧栏已经拉过，这里命中缓存）；里面没有就先不显示名字。 */
const useConversationTitle = (conversationId: string): string => {
  const topology = useSidebarTopology(true)
  const rows = [
    ...(topology.data?.ungrouped.items ?? []),
    ...(topology.data?.collections.flatMap((collection) => collection.page.items) ?? []),
  ]
  return rows.find((row) => row.id === conversationId)?.title ?? '对话'
}
