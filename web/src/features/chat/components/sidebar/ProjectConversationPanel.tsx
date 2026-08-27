import { useLayoutEffect, useRef } from 'react'
import type {
  ProjectAssistantBubbleTimelineItem,
  ProjectChatInterrupt,
  ProjectChatTimelineItem,
} from '@/features/chat/contracts'
import type { ComposerMediaReference } from '@/shared/composer'
import { cn } from '@/shared/lib/utils'
import { MediaPreviewDialog, useMediaPreview } from '@/shared/ui/media'
import { useProjectChatConversation } from '../../state/ProjectChatProvider'
import { ProjectAgentIdentity } from './ProjectAgentIdentity'
import {
  isActiveAskTimelineItem,
  ProjectAskUserQuestionTimelineCard,
} from './ProjectAskUserQuestionTimelineCard'
import {
  assistantTimelineItemHasRenderableContent,
  isFilePart,
  isReasoningPart,
  isRenderableMessagePart,
  isTextPart,
  mediaReferenceFromFilePart,
  ProjectInlineMediaReferenceChip,
  ProjectMarkdownBlock,
  ProjectMessageFileChips,
  ProjectReasoningBlock,
} from './ProjectMessageMarkdown'
import {
  projectAgentIdentityKindFromAssistantBubble,
  ProjectSubagentFlowTimelineCard,
} from './ProjectSubagentFlowCards'
import {
  ProjectToolLogTimelineSegment,
  type ProjectToolLogDetailsRenderer,
} from './ProjectToolRunLog'

const CONVERSATION_BOTTOM_STICKY_THRESHOLD_PX = 96
const CONVERSATION_BOTTOM_SCROLL_RETRY_DELAYS_MS = [80, 240, 720]

/**
 * 渲染 assistant timeline 气泡内容。
 *
 * @param props - assistant 内容属性。
 * @param props.item - assistant-bubble timeline item。
 * @param props.running - 当前 timeline 段是否运行中。
 * @returns assistant 回复块元素。
 */
const ProjectAssistantTimelineContent = ({
  item,
  running,
}: {
  item: ProjectAssistantBubbleTimelineItem
  running: boolean
}) => {
  const parts = item.message.parts.filter(isRenderableMessagePart)

  return (
    <div className="space-y-3">
      {parts.map((part, index) => {
        if (isTextPart(part)) {
          return (
            <ProjectMarkdownBlock key={`${item.id}:text:${index.toString(36)}`} text={part.text} />
          )
        }

        if (isReasoningPart(part)) {
          return (
            <ProjectReasoningBlock
              key={`${item.id}:reasoning:${index.toString(36)}`}
              part={part}
              running={running}
            />
          )
        }

        if (isFilePart(part)) {
          return (
            <ProjectMessageFileChips
              align="start"
              files={[part]}
              key={`${item.id}:assistant-file:${part.url}:${index.toString(36)}`}
            />
          )
        }

        return null
      })}
    </div>
  )
}

/**
 * 渲染 assistant timeline 回复节点。
 *
 * @param props - assistant 回复节点属性。
 * @param props.item - assistant-bubble timeline item。
 * @returns 带当前 speaker 身份牌的 assistant 时间线节点或空 shell 等待态。
 */
const ProjectAssistantTimelineBubble = ({ item }: { item: ProjectAssistantBubbleTimelineItem }) => {
  if (!assistantTimelineItemHasRenderableContent(item)) {
    return null
  }

  const isResponseShell = item.isResponseShell === true
  const hasBubbleBody = item.message.parts.some(isRenderableMessagePart)
  const identityActivity = isResponseShell ? (hasBubbleBody ? 'answering' : 'thinking') : undefined
  const identityAgent = projectAgentIdentityKindFromAssistantBubble(item.agentKind)

  return (
    <div className="flex justify-start">
      <div
        className={
          hasBubbleBody ? 'relative max-w-[92%] min-w-0' : 'relative min-h-8 max-w-[92%] min-w-40'
        }
        {...(hasBubbleBody
          ? { 'data-project-assistant-bubble': 'true' }
          : { 'data-project-assistant-response-shell': 'true' })}
      >
        <ProjectAgentIdentity activity={identityActivity} agent={identityAgent} />
        {hasBubbleBody ? (
          <div className="relative mt-2 min-w-32 border-l-2 border-chat-agent-rail py-1 pl-3">
            <ProjectAssistantTimelineContent item={item} running={isResponseShell} />
          </div>
        ) : null}
      </div>
    </div>
  )
}

/**
 * 渲染单个 timeline item。
 *
 * @param params - timeline item 渲染参数。
 * @param params.activeInterrupt - 当前 Producer 中断。
 * @param params.item - 当前 timeline item。
 * @returns 对应的 React 节点。
 */
const renderProjectTimelineItem = ({
  activeInterrupt,
  item,
  onOpenMediaPreview,
  renderToolDetails,
}: {
  activeInterrupt: ProjectChatInterrupt | null
  item: ProjectChatTimelineItem
  onOpenMediaPreview: (reference: ComposerMediaReference) => void
  renderToolDetails?: ProjectToolLogDetailsRenderer
}) => {
  switch (item.kind) {
    case 'assistant-bubble':
      return <ProjectAssistantTimelineBubble item={item} />
    case 'ask-user-question':
      return (
        <ProjectAskUserQuestionTimelineCard
          active={isActiveAskTimelineItem({
            activeInterrupt,
            item,
          })}
          item={item}
        />
      )
    case 'subagent-flow':
      return <ProjectSubagentFlowTimelineCard item={item} />
    case 'tool-log-segment':
      return <ProjectToolLogTimelineSegment item={item} renderToolDetails={renderToolDetails} />
    case 'user-message':
      return (
        <ProjectUserMessageTimelineBubble item={item} onOpenMediaPreview={onOpenMediaPreview} />
      )
    default:
      return null
  }
}

/**
 * 判断对话滚动容器是否已经接近底部。
 *
 * @param viewport - 对话列表滚动容器。
 * @returns 距离底部小于阈值时返回 true。
 */
const isConversationViewportNearBottom = (viewport: HTMLDivElement) =>
  viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <=
  CONVERSATION_BOTTOM_STICKY_THRESHOLD_PX

/**
 * 将对话滚动容器移动到内容底部。
 *
 * @param viewport - 对话列表滚动容器。
 */
const scrollConversationViewportToBottom = (viewport: HTMLDivElement) => {
  viewport.scrollTop = viewport.scrollHeight
}

/**
 * 在用户没有主动滚离当前位置时继续补一次底部滚动。
 *
 * @param params - 补滚参数。
 * @param params.expectedScrollTop - 上次自动滚动后的 scrollTop。
 * @param params.viewport - 对话列表滚动容器。
 * @returns 本次补滚后应视为自动位置的 scrollTop。
 */
const scrollConversationViewportToBottomIfUnmoved = ({
  expectedScrollTop,
  viewport,
}: {
  expectedScrollTop: number
  viewport: HTMLDivElement
}) => {
  const userMovedAway =
    Math.abs(viewport.scrollTop - expectedScrollTop) > 1 &&
    !isConversationViewportNearBottom(viewport)

  if (userMovedAway) {
    return expectedScrollTop
  }

  scrollConversationViewportToBottom(viewport)

  return viewport.scrollTop
}

/**
 * 安排一次对话底部滚动，覆盖 DOM 提交后内容高度继续变化的情况。
 *
 * @param params - 底部滚动调度参数。
 * @param params.onAutoScroll - 每次自动滚动后同步最新 scrollTop。
 * @param params.viewport - 对话列表滚动容器。
 *
 * @returns 取消尚未执行滚动的清理函数。
 */
const scheduleConversationViewportBottomScroll = ({
  onAutoScroll,
  viewport,
}: {
  onAutoScroll: (scrollTop: number) => void
  viewport: HTMLDivElement
}) => {
  scrollConversationViewportToBottom(viewport)
  let expectedScrollTop = viewport.scrollTop
  onAutoScroll(expectedScrollTop)

  if (typeof window === 'undefined') {
    return () => {}
  }

  const frameIds: number[] = []
  const timeoutIds: number[] = []
  /**
   * 尝试跟随内容高度变化补滚到底部。
   */
  const followBottomIfUnmoved = () => {
    expectedScrollTop = scrollConversationViewportToBottomIfUnmoved({
      expectedScrollTop,
      viewport,
    })
    onAutoScroll(expectedScrollTop)
  }

  if (typeof window.requestAnimationFrame === 'function') {
    frameIds.push(window.requestAnimationFrame(followBottomIfUnmoved))
  }

  for (const delay of CONVERSATION_BOTTOM_SCROLL_RETRY_DELAYS_MS) {
    timeoutIds.push(window.setTimeout(followBottomIfUnmoved, delay))
  }

  return () => {
    for (const frameId of frameIds) {
      window.cancelAnimationFrame(frameId)
    }

    for (const timeoutId of timeoutIds) {
      window.clearTimeout(timeoutId)
    }
  }
}

/**
 * 渲染单条用户消息 timeline 气泡。
 *
 * @param props - 用户消息渲染属性。
 * @param props.item - 用户消息 timeline item。
 * @returns 右侧用户消息气泡。
 */
const ProjectUserMessageTimelineBubble = ({
  item,
  onOpenMediaPreview,
}: {
  item: Extract<ProjectChatTimelineItem, { kind: 'user-message' }>
  onOpenMediaPreview: (reference: ComposerMediaReference) => void
}) => {
  // 用户输入只有纯文本与媒体引用（composer schema），按 part 顺序内联渲染；
  // 文本内换行由 whitespace-pre-wrap 保留，chip 在原位置内联。
  const parts = item.message.parts

  return (
    <div className="flex justify-end">
      <div
        className="max-w-[82%] min-w-0 cursor-text rounded-xl border border-chat-user-border bg-chat-user-bg px-4 py-3 text-left text-body-sm leading-[1.58] whitespace-pre-wrap text-chat-message-text shadow-[var(--shadow-chat-user)] select-text"
        data-project-user-message="true"
      >
        {parts.map((part, partIndex) => {
          if (isTextPart(part)) {
            return <span key={`text:${partIndex.toString(36)}`}>{part.text}</span>
          }

          if (!isFilePart(part)) {
            return null
          }

          const fileOrdinal = parts.slice(0, partIndex).filter(isFilePart).length
          return (
            <ProjectInlineMediaReferenceChip
              key={`file:${part.url}:${partIndex.toString(36)}`}
              onOpenPreview={onOpenMediaPreview}
              reference={mediaReferenceFromFilePart(part, fileOrdinal)}
            />
          )
        })}
      </div>
    </div>
  )
}

/**
 * 根据 timeline item 类型选择时间线节点标记样式。
 *
 * @param item - 当前 timeline item。
 * @returns 时间线标记的 className。
 */
const projectTimelineMarkerClassName = (item: ProjectChatTimelineItem) => {
  switch (item.kind) {
    case 'ask-user-question':
      return 'border-chat-agent-rail bg-chat-agent-rail'
    case 'subagent-flow':
    case 'tool-log-segment':
      return 'border-chat-status-success bg-chat-status-success'
    case 'user-message':
      return 'border-chat-user-border bg-chat-user-bg'
    default:
      return 'border-chat-inline-border bg-chat-panel-bg'
  }
}

/**
 * 渲染 Producer 项目对话历史面板。
 *
 * @returns 包含全部用户与 assistant timeline 的面板内容。
 */
export default function ProjectConversationPanel() {
  const { activeInterrupt, timelineItems } = useProjectChatConversation()

  return (
    <ProjectConversationTimeline activeInterrupt={activeInterrupt} timelineItems={timelineItems} />
  )
}

/**
 * 渲染已经由 AG-UI 消息投影出的 Producer 对话时间线。
 *
 * 项目聊天与独立 Agent 调试页共用这一展示层，避免各自解释 text、reasoning、
 * tool-call 与失败状态。业务 Provider 只负责提供 timeline 数据。
 *
 * @param props - 时间线输入。
 * @param props.activeInterrupt - 当前交互中断；无 HITL 时传 null。
 * @param props.renderToolDetails - 可选的逐工具调试详情渲染器。
 * @param props.title - 时间线标题。
 * @param props.timelineItems - 连续对话时间线节点。
 * @returns 标准 Producer 对话面板。
 */
export function ProjectConversationTimeline({
  activeInterrupt,
  renderToolDetails,
  title = '对话',
  timelineItems,
}: {
  activeInterrupt: ProjectChatInterrupt | null
  renderToolDetails?: ProjectToolLogDetailsRenderer
  title?: string
  timelineItems: ProjectChatTimelineItem[]
}) {
  const { closePreview, openPreview, preview } = useMediaPreview()
  const scrollViewportRef = useRef<HTMLDivElement | null>(null)
  const latestAutoScrollItemIdRef = useRef<string | null>(null)
  const hasAutoScrolledToConversationEndRef = useRef(false)
  const expectedAutoScrollTopRef = useRef<number | null>(null)

  useLayoutEffect(() => {
    const viewport = scrollViewportRef.current

    if (!viewport || timelineItems.length === 0) {
      hasAutoScrolledToConversationEndRef.current = false
      expectedAutoScrollTopRef.current = null
      latestAutoScrollItemIdRef.current = null
      return undefined
    }

    const latestItemId = timelineItems.at(-1)?.id ?? null
    const latestItemChanged = latestAutoScrollItemIdRef.current !== latestItemId
    const shouldForceScroll = !hasAutoScrolledToConversationEndRef.current || latestItemChanged
    const isAtPreviousAutoScrollPosition =
      expectedAutoScrollTopRef.current !== null &&
      Math.abs(viewport.scrollTop - expectedAutoScrollTopRef.current) <= 1
    latestAutoScrollItemIdRef.current = latestItemId

    if (
      !shouldForceScroll &&
      !isConversationViewportNearBottom(viewport) &&
      !isAtPreviousAutoScrollPosition
    ) {
      return undefined
    }

    hasAutoScrolledToConversationEndRef.current = true

    return scheduleConversationViewportBottomScroll({
      onAutoScroll: (scrollTop) => {
        expectedAutoScrollTopRef.current = scrollTop
      },
      viewport,
    })
  }, [timelineItems])

  if (timelineItems.length === 0) {
    return <div className="min-h-0 flex-1" />
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-chat-inline-border px-5 pt-5 pb-3">
        <h2 className="text-body leading-none font-semibold text-chat-message-text">{title}</h2>
        <span className="text-label leading-none font-medium text-chat-muted-text">全部</span>
      </div>
      <div
        aria-label={`${title}内容`}
        className="thin-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pt-4 pb-5"
        data-project-conversation-scroll="true"
        data-scrollable
        ref={scrollViewportRef}
        role="region"
        tabIndex={0}
      >
        <div className="relative space-y-5 pl-8 before:absolute before:top-2 before:bottom-2 before:left-[10px] before:w-px before:bg-chat-inline-border">
          {timelineItems.map((item) => {
            const timelineNode = renderProjectTimelineItem({
              activeInterrupt,
              item,
              onOpenMediaPreview: openPreview,
              renderToolDetails,
            })

            return timelineNode ? (
              <div className="relative" key={item.id}>
                <span
                  aria-hidden="true"
                  className={cn(
                    'layer-local-1 absolute top-2 left-[-27px] h-3.5 w-3.5 rounded-full border-2',
                    projectTimelineMarkerClassName(item),
                  )}
                />
                {timelineNode}
              </div>
            ) : null
          })}
        </div>
      </div>
      {preview ? (
        <MediaPreviewDialog
          key={`${preview.mediaType}:${preview.attachmentId ?? preview.url}`}
          onClose={closePreview}
          preview={preview}
        />
      ) : null}
    </div>
  )
}
