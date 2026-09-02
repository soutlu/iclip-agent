/**
 * 会话页：一段对话的内容，底下贴着输入框。
 *
 * 内容来自 `useTranscript`——订阅、拉基线、补漏都在它里面，这里只管铺开、滚动与发送。
 *
 * 标题来自基线（首屏那一份），之后被自动起名或改名会由推送盖过去。不从侧栏那份拓扑里翻：
 * 拓扑只有每段列表的第一页，从搜索里点开一段更早的对话就翻不到，标题会退成「对话」。
 */

import { useEffect, useRef, useState } from 'react'
import { useSessionUpdates } from '@/shared/transcript/use-session-updates'
import { useTranscript } from '@/shared/transcript/use-transcript'
import type { TranscriptAttachment, TranscriptTurn } from '@/shared/transcript/vendor'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import type { ComposerAttachment } from '@/shared/ui/composer'
import { toast } from '@/shared/ui/toast'
import {
  abortPrompt,
  mintPromptId,
  promptMedia,
  promptText,
  regeneratePrompt,
  steerPrompt,
  submitPrompt,
} from '../conversations.api'
import { ConversationComposer } from './conversation-composer'
import { ConversationTurn } from './conversation-turn'
import { PromptQueue } from './prompt-queue'
import { UserBubble } from './user-bubble'
import { WorkingIndicator } from './working-indicator'

/** 离底多少像素之内算「还贴着底」，越过就不再自动跟随。照 kimi。 */
const STICK_THRESHOLD_PX = 80

/** 停止滚动多久之后把滚动条收回去（照 kimi：滚动条只在滚动中与悬停时浮现）。 */
const SCROLL_IDLE_MS = 600

/** Kimi 的 Requesting → Working 判据：非空助手正文/思考，或任一工具块。 */
const hasAssistantOutput = (turn: TranscriptTurn | undefined): boolean =>
  turn?.steps.some((step) =>
    step.frames.some((frame) => {
      if (frame.kind === 'tool') return true
      if (frame.kind === 'thinking') return frame.text.trim().length > 0
      return frame.kind === 'text' && frame.role === 'assistant' && frame.text.trim().length > 0
    }),
  ) ?? false

type ConversationRouteProps = {
  conversationId: string
}

type PendingPrompt = {
  promptId: string
  text: string
  media: readonly ComposerAttachment[]
  anchorTurnId: string | undefined
}

/** 乐观气泡的附件实体：id 用本地 attId（认领后整条撤掉，不会与服务端的实体撞车）。 */
const optimisticAttachments = (
  media: readonly ComposerAttachment[],
): readonly TranscriptAttachment[] =>
  media.flatMap((item) =>
    item.url !== undefined
      ? [
          {
            attachmentId: item.attId,
            mediaType: item.mediaType,
            name: item.name,
            size: item.size,
            source: { kind: 'url' as const, url: item.url },
          },
        ]
      : [],
  )

/**
 * 渲染会话页。
 *
 * @param props - 组件属性。
 * @param props.conversationId - 哪一段对话。
 * @returns 会话页内容。
 */
export function ConversationRoute({ conversationId }: ConversationRouteProps) {
  const { view, refresh } = useTranscript(conversationId)
  const { titleOf } = useSessionUpdates()
  const title = titleOf(conversationId) ?? view.title
  const [pending, setPending] = useState<readonly PendingPrompt[]>([])
  const [inFlightPromptId, setInFlightPromptId] = useState<string | null>(null)

  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const stickingRef = useRef(true)
  // 「贴着底」同时是一份状态：离开底部时浮出「回到底部」胶囊（照 kimi 的 newmsg-pill）
  const [sticking, setSticking] = useState(true)
  const scrollIdleRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const scroller = scrollerRef.current
    if (scroller === null || !stickingRef.current) return
    scroller.scrollTop = scroller.scrollHeight
  }, [view.items, pending])

  useEffect(
    () => () => {
      if (scrollIdleRef.current !== null) clearTimeout(scrollIdleRef.current)
    },
    [],
  )

  const turns = view.items.filter((item) => item.kind === 'turn')

  // 照 Kimi：running prompt 本身不认领乐观消息；必须等 anchor 之后的 turn.prompt 真正接手。
  // queued 由队列行接手，终态则直接收掉，二者都不再保留气泡。
  const promptById = new Map(view.prompts.map((prompt) => [prompt.promptId, prompt]))
  const claimed = (item: PendingPrompt) => {
    const prompt = promptById.get(item.promptId)
    if (prompt?.status === 'queued') return true
    if (prompt !== undefined && prompt.status !== 'running') return true

    const anchorIndex =
      item.anchorTurnId === undefined
        ? -1
        : turns.findIndex((turn) => turn.turnId === item.anchorTurnId)
    if (item.anchorTurnId !== undefined && anchorIndex === -1) return false
    return turns.slice(anchorIndex + 1).some((turn) => {
      if (item.text !== '' && turn.prompt === item.text) return true
      return item.text === '' && item.media.length > 0 && (turn.attachmentIds?.length ?? 0) > 0
    })
  }
  const bubbles = pending.filter((item) => !claimed(item))
  const queued = view.prompts.filter((prompt) => prompt.status === 'queued')
  const running = view.prompts.find((prompt) => prompt.status === 'running')
  // 照 Kimi：inFlight 是本地提交生命周期，turnActive 直接读 transcript meta。
  // prompt 队列不参与 working 判据；这里只用终态 prompt 给本地 inFlight 收尾。
  const latestTurn = turns.at(-1)
  const turnActive = view.activity === 'turn'
  const submittedPrompt =
    inFlightPromptId === null
      ? undefined
      : view.prompts.find((prompt) => prompt.promptId === inFlightPromptId)
  const hasLivePrompts = running !== undefined || queued.length > 0
  const submittedSettled =
    submittedPrompt !== undefined &&
    submittedPrompt.status !== 'queued' &&
    submittedPrompt.status !== 'running'
  const inFlightSettled =
    inFlightPromptId !== null && submittedSettled && !turnActive && !hasLivePrompts
  if (inFlightSettled) setInFlightPromptId(null)
  const inFlight = inFlightPromptId !== null && !inFlightSettled
  const working = inFlight || turnActive
  // 重新生成只对空闲对话的末轮开放：在跑、排着、本地还在发都算忙（与服务端 409 同一判据）。
  const conversationBusy = working || hasLivePrompts
  const retry = turnActive ? latestTurn?.steps.at(-1)?.retry : undefined
  const currentAnchor = pending.at(-1)?.anchorTurnId
  const currentTurn = inFlight && latestTurn?.turnId === currentAnchor ? undefined : latestTurn
  const workingLabel =
    retry === undefined
      ? hasAssistantOutput(currentTurn)
        ? '工作中…'
        : '请求中…'
      : `模型请求失败，正在重试（第 ${retry.nextAttempt}/${retry.maxAttempts} 次）…`
  const showEmptyState = view.status === 'ready' && turns.length === 0 && bubbles.length === 0

  const send = async (text: string, media: readonly ComposerAttachment[]) => {
    const promptId = mintPromptId()
    const startsFlight = inFlightPromptId === null
    if (startsFlight) setInFlightPromptId(promptId)
    setPending((list) => [
      ...list.filter((item) => !claimed(item)),
      { anchorTurnId: latestTurn?.turnId, media, promptId, text },
    ])
    try {
      await submitPrompt(conversationId, { media, promptId, text })
    } catch (error) {
      // 没送到就把气泡撤掉——留着一条永远认领不到的更糟；输入框那边会把内容还回去。
      setPending((list) => list.filter((item) => item.promptId !== promptId))
      if (startsFlight) {
        setInFlightPromptId((current) => (current === promptId ? null : current))
      }
      throw error
    }
  }

  /** 出错就地报一声：这几个动作都不该把页面推走。 */
  const act = (work: Promise<void>) => {
    void work.catch((error: unknown) => {
      toast.error(error instanceof Error ? error.message : '操作失败')
    })
  }

  const scrollToBottom = () => {
    const scroller = scrollerRef.current
    if (scroller === null) return
    stickingRef.current = true
    setSticking(true)
    scroller.scrollTo({ behavior: 'smooth', top: scroller.scrollHeight })
  }

  return (
    // h-dvh 顶死视口高：不顶死的话壳（min-h-dvh）会跟着长文内容长，整页外滚、composer 掉出
    // 视口底。顶死后滚动只发生在消息区内部，停靠、粘底、回到底部胶囊才都成立（照 kimi chat-dock）
    <main className="flex h-dvh min-h-0 flex-1 flex-col overflow-hidden">
      <header className="flex h-12 shrink-0 items-center border-b-[0.5px] border-chat-hairline px-4">
        <h1 className="truncate text-body font-medium text-on-surface">{title}</h1>
      </header>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          className="chat-scroller min-h-0 flex-1 overflow-y-auto"
          onScroll={(event) => {
            const scroller = event.currentTarget
            const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
            stickingRef.current = distance <= STICK_THRESHOLD_PX
            setSticking(stickingRef.current)
            // 滚动中把滚动条露出来，停滚一会儿再收回（直接改 DOM，不引重渲）
            scroller.dataset['scrolling'] = 'true'
            if (scrollIdleRef.current !== null) clearTimeout(scrollIdleRef.current)
            scrollIdleRef.current = setTimeout(() => {
              delete scroller.dataset['scrolling']
            }, SCROLL_IDLE_MS)
          }}
          ref={scrollerRef}
        >
          <div
            className={cn(
              'mx-auto flex min-h-full w-full max-w-(--layout-home-read-max) flex-col gap-4 px-5 pt-2',
              showEmptyState ? 'pb-4' : 'pb-[81px]',
            )}
          >
            {view.status === 'loading' ? (
              <p className="flex items-center gap-2 py-12 text-body-sm text-on-surface-variant">
                <Icon className="animate-spin" decorative name="loading" size="sm" />
                正在读取对话
              </p>
            ) : null}
            {turns.map((turn) => (
              <ConversationTurn
                attachments={view.attachments}
                key={turn.turnId}
                onRegenerate={
                  turn.turnId === latestTurn?.turnId
                    ? () => act(regeneratePrompt(conversationId, turn.turnId))
                    : undefined
                }
                regenerateDisabled={conversationBusy}
                turn={turn}
              />
            ))}
            {bubbles.map((item) => (
              <UserBubble
                attachments={
                  item.media.length === 0 ? undefined : optimisticAttachments(item.media)
                }
                key={item.promptId}
                text={item.text}
              />
            ))}
            {working ? (
              <div className="self-start py-2.5">
                <WorkingIndicator label={workingLabel} />
              </div>
            ) : null}
            <PromptQueue
              canSteer={running !== undefined}
              onDiscard={(promptId) => act(abortPrompt(conversationId, promptId))}
              onSteer={(promptId) => act(steerPrompt(conversationId, promptId))}
              prompts={queued.map((prompt) => ({
                media: promptMedia(prompt.content),
                promptId: prompt.promptId,
                text: promptText(prompt.content),
              }))}
            />
            {showEmptyState ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-3 py-16 text-center">
                <span className="font-home-display text-headline-lg font-semibold text-on-surface italic">
                  Cue
                </span>
                <p className="text-body-sm text-on-surface-variant">
                  还没有消息 —— 在下方输入开始对话
                </p>
              </div>
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
        {sticking ? null : (
          <button
            className="absolute bottom-4 left-1/2 flex -translate-x-1/2 animate-in ui-state cursor-pointer items-center gap-1 rounded-full border-[0.5px] border-chat-hairline bg-top-layer px-3 py-1.5 text-body-sm text-chat-secondary-text shadow-[var(--shadow-1)] ui-focus duration-(--dur-s) ease-(--ease-decel) fade-in slide-in-from-bottom-2"
            onClick={scrollToBottom}
            type="button"
          >
            <Icon decorative name="to-bottom" size="sm" />
            回到底部
          </button>
        )}
      </div>
      <div className="relative shrink-0 px-5 pb-4">
        {/* 输入卡上方一段渐隐：内容滚到卡后面时不会齐刷刷切断（照 kimi 的 chat-dock） */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 -top-12 h-12 bg-gradient-to-b from-transparent to-background"
        />
        <div className="mx-auto w-full max-w-(--layout-home-read-max)">
          <ConversationComposer
            busy={running !== undefined}
            onSend={send}
            onStop={
              running === undefined
                ? undefined
                : () => act(abortPrompt(conversationId, running.promptId))
            }
          />
        </div>
      </div>
    </main>
  )
}
