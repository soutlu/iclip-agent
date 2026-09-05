/** 标题来自 transcript 基线与推送；侧栏拓扑仅包含各列表首页，无法覆盖全部历史对话。 */

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
import { ApprovalCard } from './approval-card'
import { ConversationComposer } from './conversation-composer'
import { ConversationTurn } from './conversation-turn'
import { PromptQueue } from './prompt-queue'
import { UserBubble } from './user-bubble'
import { WorkingIndicator } from './working-indicator'

const STICK_THRESHOLD_PX = 80

const SCROLL_IDLE_MS = 600

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

/** 参考 Kimi Requesting → Working：助手正文、思考非空或存在工具块。 */
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
  content: readonly PromptContentPart[]
  anchorTurnId: string | undefined
}

/** 保留原内容用于校验末轮身份；重新生成可能复用轮号。 */
type EditingTurn = {
  turnId: string
  ordinal: number
  content: readonly PromptContentPart[]
}

const sameContent = (a: readonly PromptContentPart[], b: readonly PromptContentPart[]) =>
  a.length === b.length &&
  a.every((part, index) => {
    const other = b[index]
    if (other === undefined || other.type !== part.type) return false
    return part.type === 'text'
      ? other.type === 'text' && other.text === part.text
      : other.type !== 'text' && other.source.url === part.source.url
  })

export function ConversationRoute({ conversationId }: ConversationRouteProps) {
  const { view, refresh } = useTranscript(conversationId)
  const { titleOf } = useSessionTitles()
  const title = titleOf(conversationId) ?? view.title
  const [pending, setPending] = useState<readonly PendingPrompt[]>([])
  const [inFlightPromptId, setInFlightPromptId] = useState<string | null>(null)
  const [editingTurn, setEditingTurn] = useState<EditingTurn | null>(null)

  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const stickingRef = useRef(true)
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
  // 每次仅显示一张审批卡；其他待处理交互依次展示。
  const approval = view.pendingInteractions.find(
    (interaction) => interaction.interactionKind === 'approval',
  )

  // 乐观气泡仅由 anchor 之后且 content 相同的轮接替；queued 由队列行接替，终态 prompt 移除气泡。
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
  // inFlight 表示本地提交状态，turnActive 取 transcript meta；队列不参与 working 判定。
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
  // 重新生成仅允许空闲对话末轮；运行、排队或本地提交中均视为忙，与服务端 409 条件一致。
  const conversationBusy = working || hasLivePrompts
  // 同时核对轮号和原内容，防止末轮替换或轮号复用后继续修改旧轮。
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

  /** 发送失败时撤销乐观气泡，输入框负责恢复内容；仅 anchorTurnId 之后的轮可接替气泡。 */
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
      : // 修改末轮后服务端会替换旧轮，乐观气泡锚定在前一轮之后。
        dispatch(parts, turns.at(-2)?.turnId, async (promptId, content) => {
          await regeneratePrompt(conversationId, editing.turnId, { content, promptId })
          setEditingTurn(null)
        })

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
    // 固定视口高度，使滚动限制在消息区，保持输入框和自动跟随定位稳定。
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
              // 等待审批时不能向当前轮追加消息。
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
