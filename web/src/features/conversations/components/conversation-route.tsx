/**
 * 会话页：一段对话的内容。
 *
 * 内容来自 `useTranscript`——订阅、拉基线、补漏都在它里面，这里只管铺开与滚动。
 */

import { useEffect, useRef } from 'react'
import { useTranscript } from '@/shared/transcript/use-transcript'
import { Icon } from '@/shared/icons'
import { Button } from '@/shared/ui/button'
import { useSidebarTopology } from '../conversations.api'
import { ConversationTurn } from './conversation-turn'

/** 离底多少像素之内算「还贴着底」，越过就不再自动跟随。照 kimi。 */
const STICK_THRESHOLD_PX = 80

type ConversationRouteProps = {
  conversationId: string
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

  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const stickingRef = useRef(true)

  useEffect(() => {
    const scroller = scrollerRef.current
    if (scroller === null || !stickingRef.current) return
    scroller.scrollTop = scroller.scrollHeight
  }, [view.items])

  const turns = view.items.filter((item) => item.kind === 'turn')

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
        <div className="mx-auto flex w-full max-w-(--layout-home-read-max) flex-col gap-4 px-5 pt-2 pb-12">
          {view.status === 'loading' ? (
            <p className="flex items-center gap-2 py-12 text-body-sm text-on-surface-variant">
              <Icon className="animate-spin" decorative name="loading" size="sm" />
              正在读取对话
            </p>
          ) : null}
          {turns.map((turn) => (
            <ConversationTurn key={turn.turnId} turn={turn} />
          ))}
          {view.status === 'ready' && turns.length === 0 ? (
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
