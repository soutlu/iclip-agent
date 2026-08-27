import type {
  ProjectAssistantBubbleAgentKind,
  ProjectMemberSegment,
  ProjectMemberSegmentPart,
  ProjectSubagentFlowTimelineItem,
} from '@/features/chat/contracts'
import { cn } from '@/shared/lib/utils'
import { projectMemberToolActionLabel } from '../../lib/project-tool-log'
import {
  PROJECT_AGENT_KIND,
  ProjectAgentIdentity,
  type ProjectAgentKind,
} from './ProjectAgentIdentity'
import { ProjectMarkdownBlock } from './ProjectMessageMarkdown'

/**
 * 获取子 agent 流程事件的状态文案。
 *
 * @param status - 子 agent 事件状态。
 * @returns 用户可读状态文案。
 */
export const subagentFlowStatusLabel = (
  status: ProjectSubagentFlowTimelineItem['events'][number]['status'],
) => {
  switch (status) {
    case 'completed':
      return '已完成'
    case 'failed':
      return '运行失败'
    case 'started':
      return '已交接'
    default:
      return '已交接'
  }
}

/**
 * 读取子 agent 事件的卡片视觉样式。
 *
 * @param status - 子 agent 事件状态。
 * @returns 当前事件状态对应的卡片、图标和流程点样式。
 */
export const subagentFlowEventStyle = (
  status: ProjectSubagentFlowTimelineItem['events'][number]['status'],
): {
  accentIcon: string
  iconClassName: string
  markerClassName: string
  statusBadgeClassName: string
  statusTextClassName: string
} => {
  switch (status) {
    case 'completed':
      return {
        accentIcon: '✓',
        iconClassName: 'border-chat-status-success bg-chat-tool-bg text-chat-status-success',
        markerClassName: 'border-chat-status-success bg-chat-status-success',
        statusBadgeClassName: 'bg-chat-status-success text-chat-card-bg',
        statusTextClassName: 'text-chat-status-success',
      }
    case 'failed':
      return {
        accentIcon: '!',
        iconClassName: 'border-chat-error-border bg-chat-error-bg text-chat-error-text',
        markerClassName: 'border-chat-error-text bg-chat-error-text',
        statusBadgeClassName: 'bg-chat-error-bg text-chat-error-text',
        statusTextClassName: 'text-chat-error-text',
      }
    default:
      return {
        accentIcon: '↗',
        iconClassName: 'border-chat-status-running bg-chat-tool-bg text-chat-status-running',
        markerClassName: 'border-chat-status-running bg-chat-status-running',
        statusBadgeClassName: 'bg-chat-status-running text-chat-card-bg',
        statusTextClassName: 'text-chat-status-running',
      }
  }
}

/**
 * 将子 agent 目标映射成本地身份牌类型。
 *
 * @param targetLabel - timeline 中的用户可见子 agent 名称。
 * @returns 可复用头像身份类型；未知目标返回 null。
 */
export const projectAgentIdentityKindFromSubagentTarget = (
  targetLabel: string,
): ProjectAgentKind | null => {
  if (targetLabel === '创意策划师') {
    return PROJECT_AGENT_KIND.CreativeDirector
  }

  if (targetLabel === '分镜执行导演') {
    return PROJECT_AGENT_KIND.Storyboard
  }

  return null
}

/**
 * 将 assistant-bubble 的 speaker 类型映射为本地身份牌类型。
 *
 * @param agentKind - timeline item 上的 assistant speaker。
 * @returns 可用于渲染头像和身份牌的本地 Agent 类型。
 */
export const projectAgentIdentityKindFromAssistantBubble = (
  agentKind: ProjectAssistantBubbleAgentKind,
): ProjectAgentKind => {
  switch (agentKind) {
    case 'creative-director':
      return PROJECT_AGENT_KIND.CreativeDirector
    case 'storyboard':
      return PROJECT_AGENT_KIND.Storyboard
    default:
      return PROJECT_AGENT_KIND.Producer
  }
}

/**
 * 渲染子 agent 流程中的单个状态卡。
 *
 * @param props - 状态卡属性。
 * @param props.event - 子 agent 事件。
 * @returns 带左侧流程点和状态图标的事件卡片。
 */
export const ProjectSubagentFlowEventCard = ({
  event,
}: {
  event: ProjectSubagentFlowTimelineItem['events'][number]
}) => {
  const style = subagentFlowEventStyle(event.status)
  const terminalIcon = event.status === 'failed' ? '!' : '✓'

  return (
    <div className="relative pl-8" data-project-subagent-flow-event={event.status}>
      <span
        aria-hidden="true"
        className={cn(
          'layer-local-1 absolute top-2 left-0 grid h-5 w-5 place-items-center rounded-full border-4 border-chat-panel-bg',
          style.markerClassName,
        )}
      >
        <span className="h-2 w-2 rounded-full bg-chat-card-bg opacity-80" />
      </span>
      <div className="flex min-w-0 items-start gap-3 border-b border-chat-inline-border pb-3">
        <span
          aria-hidden="true"
          className={cn(
            'grid h-8 w-8 shrink-0 place-items-center rounded-sm border text-body leading-none font-semibold',
            style.iconClassName,
          )}
        >
          {style.accentIcon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-body-sm leading-snug font-medium [overflow-wrap:anywhere] text-chat-message-text">
            {event.label}
          </div>
          <div
            className={cn('mt-1 text-caption leading-none font-medium', style.statusTextClassName)}
          >
            {subagentFlowStatusLabel(event.status)}
          </div>
        </div>
        <span
          aria-hidden="true"
          className={cn(
            'grid h-5 w-5 shrink-0 place-items-center rounded-full text-label leading-none font-semibold',
            style.statusBadgeClassName,
          )}
        >
          {terminalIcon}
        </span>
      </div>
    </div>
  )
}

/**
 * 渲染成员活动流中的单个工具动作行。
 *
 * @param props - 工具动作行属性。
 * @param props.part - 成员工具 part。
 * @returns 紧凑的工具动作状态行。
 */
export const ProjectMemberToolActivityLine = ({ part }: { part: ProjectMemberSegmentPart }) => {
  if (part.type === 'text' || part.type === 'reasoning') {
    return null
  }

  const actionLabel = projectMemberToolActionLabel(part.type.slice('tool-'.length))
  const failed = part.state === 'output-error'
  const completed = part.state === 'output-available'

  return (
    <div
      className="flex items-center gap-2 text-label leading-none text-chat-muted-text"
      data-project-member-tool-state={part.state ?? 'input-available'}
    >
      <span
        aria-hidden="true"
        className={cn(
          'grid h-4 w-4 shrink-0 place-items-center rounded-full text-caption leading-none font-semibold',
          failed
            ? 'bg-chat-error-bg text-chat-error-text'
            : completed
              ? 'bg-chat-tool-bg text-chat-status-success'
              : 'bg-chat-tool-bg text-chat-status-running',
        )}
      >
        {failed ? '!' : completed ? '✓' : '·'}
      </span>
      <span>{actionLabel}</span>
    </div>
  )
}

/**
 * 渲染单个成员活动段：成员实时产出的文本、推理与工具动作。
 *
 * @param props - 成员活动段属性。
 * @param props.segment - 成员活动段。
 * @returns 按发生顺序排列的成员活动内容块。
 */
export const ProjectMemberSegmentActivity = ({ segment }: { segment: ProjectMemberSegment }) => (
  <div
    className="space-y-2 border-l-2 border-chat-agent-rail py-1 pl-3"
    data-project-member-activity={segment.memberRunId}
  >
    {segment.parts.map((part, index) => {
      if (part.type === 'text') {
        return (
          <ProjectMarkdownBlock
            key={`${segment.memberRunId}:text:${index.toString(36)}`}
            text={part.text}
          />
        )
      }

      if (part.type === 'reasoning') {
        return (
          <div
            className="text-label leading-5 whitespace-pre-wrap text-chat-muted-text"
            key={`${segment.memberRunId}:reasoning:${index.toString(36)}`}
          >
            {part.text}
          </div>
        )
      }

      return (
        <ProjectMemberToolActivityLine
          key={`${segment.memberRunId}:tool:${part.toolCallId}`}
          part={part}
        />
      )
    })}
  </div>
)

/**
 * 渲染子 agent 委派流程。
 *
 * @param props - 子 agent 流程属性。
 * @param props.item - 子 agent timeline item。
 * @returns 交接事件、成员活动与完成事件列表。
 */
export const ProjectSubagentFlowTimelineCard = ({
  item,
}: {
  item: ProjectSubagentFlowTimelineItem
}) => {
  const identityAgent = projectAgentIdentityKindFromSubagentTarget(item.targetLabel)
  const [handoffEvent, ...followUpEvents] = item.events
  const segments = item.segments ?? []

  return (
    <div className="flex justify-start pr-1" data-project-subagent-flow="true">
      <div
        className="relative w-full max-w-[94%] min-w-0"
        data-project-subagent-target={item.targetLabel}
      >
        {identityAgent ? <ProjectAgentIdentity agent={identityAgent} /> : null}
        <div className={identityAgent ? 'relative mt-3' : 'relative'}>
          {item.events.length > 1 ? (
            <span
              aria-hidden="true"
              className="absolute top-7 bottom-5 left-2.5 w-px bg-chat-inline-border"
            />
          ) : null}
          <div className="space-y-3">
            {handoffEvent ? (
              <ProjectSubagentFlowEventCard event={handoffEvent} key={handoffEvent.id} />
            ) : null}
            {segments.length > 0 ? (
              <div className="relative pl-8">
                <div className="space-y-3">
                  {segments.map((segment) => (
                    <ProjectMemberSegmentActivity key={segment.memberRunId} segment={segment} />
                  ))}
                </div>
              </div>
            ) : null}
            {followUpEvents.map((event) => (
              <ProjectSubagentFlowEventCard event={event} key={event.id} />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
