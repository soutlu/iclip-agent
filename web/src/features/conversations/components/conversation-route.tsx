/**
 * 会话页：一段对话的内容，底下贴着输入框。
 *
 * 内容来自 `useTranscript`——订阅、拉基线、补漏都在它里面，这里只管铺开、滚动与发送。
 *
 * 标题来自基线（首屏那一份），之后被自动起名或改名会由推送盖过去。不从侧栏那份拓扑里翻：
 * 拓扑只有每段列表的第一页，从搜索里点开一段更早的对话就翻不到，标题会退成「对话」。
 */

import { useEffect, useRef, useState } from 'react'
import { useSessionTitles } from '@/shared/transcript/use-session-titles'
import { useTranscript } from '@/shared/transcript/use-transcript'
import type { PromptContentPart, ToolCallFrame, TranscriptTurn } from '@/shared/transcript/vendor'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import type { ComposerPart } from '@/shared/ui/composer'
import { toast } from '@/shared/ui/toast'
import {
  abortPrompt,
  mintPromptId,
  composerParts,
  partsContent,
  promptMedia,
  promptText,
  regeneratePrompt,
  steerPrompt,
  submitPrompt,
} from '../conversations.api'
import { useClearUnread } from '../conversations.unread'
import { ApprovalCard } from './approval-card'
import { ConversationComposer } from './conversation-composer'
import { ConversationTurn } from './conversation-turn'
import { PromptQueue } from './prompt-queue'
import { UserBubble } from './user-bubble'
import { WorkingIndicator } from './working-indicator'

/** 离底多少像素之内算「还贴着底」，越过就不再自动跟随。照 kimi。 */
const STICK_THRESHOLD_PX = 80

/** 停止滚动多久之后把滚动条收回去（照 kimi：滚动条只在滚动中与悬停时浮现）。 */
const SCROLL_IDLE_MS = 600

/** 审批卡对着的那次调用：帧上的 `approvalId` 就是这张卡的 id。 */
const frameAwaiting = (
  turns: readonly TranscriptTurn[],
  interactionId: string,
): ToolCallFrame | undefined =>
  turns
    .flatMap((turn) => turn.steps)
    .flatMap((step) => step.frames)
    .find(
      (frame): frame is ToolCallFrame =>
        frame.kind === 'tool' && frame.approvalId === interactionId,
    )

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
  /** 发出去的那份 part 列表；服务端回来的轮头部带的是同一份。 */
  content: readonly PromptContentPart[]
  anchorTurnId: string | undefined
}

/** 正在修改的那一轮：轮 id、轮号与原内容。内容留着是为了核「末轮还是不是它」——轮号会复用。 */
type EditingTurn = {
  turnId: string
  ordinal: number
  content: readonly PromptContentPart[]
}

/** 两份 part 列表是不是同一条消息：逐项比类型与正文 / 地址。 */
const sameContent = (a: readonly PromptContentPart[], b: readonly PromptContentPart[]) =>
  a.length === b.length &&
  a.every((part, index) => {
    const other = b[index]
    if (other === undefined || other.type !== part.type) return false
    return part.type === 'text'
      ? other.type === 'text' && other.text === part.text
      : other.type !== 'text' && other.source.url === part.source.url
  })

/**
 * 渲染会话页。
 *
 * @param props - 组件属性。
 * @param props.conversationId - 哪一段对话。
 * @returns 会话页内容。
 */
export function ConversationRoute({ conversationId }: ConversationRouteProps) {
  const { view, refresh } = useTranscript(conversationId)
  // 打开就算看过了：侧栏那一行的未读点在这里清掉
  useClearUnread(conversationId)
  const { titleOf } = useSessionTitles()
  const title = titleOf(conversationId) ?? view.title
  const [pending, setPending] = useState<readonly PendingPrompt[]>([])
  const [inFlightPromptId, setInFlightPromptId] = useState<string | null>(null)
  // 正在修改的那一轮：点了末轮气泡的「修改」进来，发出去或点取消出去
  const [editingTurn, setEditingTurn] = useState<EditingTurn | null>(null)

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
  // 一次只请一个决定（照 kimi）：等着的还有别的，等这张收掉再露出下一张。提问那一类不归审批卡。
  const approval = view.pendingInteractions.find(
    (interaction) => interaction.interactionKind === 'approval',
  )

  // 照 Kimi：running prompt 本身不认领乐观消息；必须等 anchor 之后的轮头部带着同一份 content 真正接手。
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
    return turns.slice(anchorIndex + 1).some((turn) => sameContent(turn.content, item.content))
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
  // 末轮换了（别人发了一条、重跑出来的新轮顶上）就不再是在改它。轮号会复用，所以连内容一起核。
  const editing =
    editingTurn !== null &&
    latestTurn?.turnId === editingTurn.turnId &&
    sameContent(latestTurn.content, editingTurn.content)
      ? editingTurn
      : null
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

  /**
   * 挂上乐观气泡、记下本地在飞，再把请求发出去。没送到就把气泡撤掉——留着一条永远认领
   * 不到的更糟；输入框那边会把内容还回去。
   *
   * @param parts - 输入框里的段。
   * @param anchorTurnId - 气泡挂在哪一轮之后，认领时只看它后面的轮。
   * @param request - 真正的请求；发消息与修改重发在这一步分道。
   */
  const dispatch = async (
    parts: readonly ComposerPart[],
    anchorTurnId: string | undefined,
    request: (promptId: string, content: readonly PromptContentPart[]) => Promise<void>,
  ) => {
    const promptId = mintPromptId()
    const content = partsContent(parts)
    const startsFlight = inFlightPromptId === null
    if (startsFlight) setInFlightPromptId(promptId)
    setPending((list) => [
      ...list.filter((item) => !claimed(item)),
      { anchorTurnId, content, promptId },
    ])
    try {
      await request(promptId, content)
    } catch (error) {
      setPending((list) => list.filter((item) => item.promptId !== promptId))
      if (startsFlight) {
        setInFlightPromptId((current) => (current === promptId ? null : current))
      }
      throw error
    }
  }

  const send = (parts: readonly ComposerPart[]) =>
    editing === null
      ? dispatch(parts, latestTurn?.turnId, (promptId, content) =>
          submitPrompt(conversationId, { content, promptId }),
        )
      : // 改末轮：旧轮会被服务端抹掉，气泡挂在它前一轮之后，等重跑出来的新轮接手
        dispatch(parts, turns.at(-2)?.turnId, async (promptId, content) => {
          await regeneratePrompt(conversationId, editing.turnId, { content, promptId })
          setEditingTurn(null)
        })

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
                editDisabled={conversationBusy}
                key={turn.turnId}
                onEdit={
                  turn.turnId === latestTurn?.turnId
                    ? () =>
                        setEditingTurn({
                          content: turn.content,
                          ordinal: turn.ordinal,
                          turnId: turn.turnId,
                        })
                    : undefined
                }
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
              <UserBubble content={item.content} key={item.promptId} />
            ))}
            {working ? (
              <div className="self-start py-2.5">
                <WorkingIndicator label={workingLabel} />
              </div>
            ) : null}
            <PromptQueue
              // 等审批的时候没有在跑的那一轮可插：追加得等决定落下去
              canSteer={running !== undefined && approval === undefined}
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
          {approval === undefined ? null : (
            <ApprovalCard
              conversationId={conversationId}
              frame={frameAwaiting(turns, approval.interactionId)}
              interactionId={approval.interactionId}
              key={approval.interactionId}
              onRefresh={refresh}
            />
          )}
          <ConversationComposer
            awaitingApproval={approval !== undefined}
            busy={running !== undefined}
            contextTokens={view.contextTokens}
            editing={
              editing === null
                ? undefined
                : { ordinal: editing.ordinal, parts: composerParts(editing.content) }
            }
            maxContextTokens={view.maxContextTokens}
            onCancelEdit={() => setEditingTurn(null)}
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
