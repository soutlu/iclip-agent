import type { CreateAppendMessage, ThreadMessage } from '@assistant-ui/react'
import type {
  ProjectAssistantBubbleAgentKind,
  ProjectAssistantBubbleTimelineItem,
  ProjectChatInterrupt,
  ProjectChatTimelineItem,
  ProjectGenericToolPart,
  ProjectMemberSegment,
  ProjectMessageMetadata,
  ProjectMessagePart,
  ProjectSubagentFlowEvent,
  ProjectSubagentFlowTimelineItem,
  ProjectToolLogSegmentTimelineItem,
} from '@/features/chat/contracts'
import { isRecord } from '@/shared/lib/guards'
import {
  projectToolLogEntryFromMessagePart,
  upsertProjectToolLogEntry,
} from '../lib/project-tool-log'
import {
  isSyntheticConfirmToolCallPart,
  PROJECT_ASSISTANT_DEFAULT_AGENT_KIND,
  PROJECT_ASSISTANT_RESPONSE_SHELL_ID,
  type ProjectAssistantTimelineInput,
  type ProjectAssistantUserMessageInput,
  stringField,
  SUBAGENT_AGENT_KIND_BY_MEMBER_ID,
  SUBAGENT_LABELS_BY_MEMBER_ID,
} from './project-agui-messages'
import {
  askTimelineItemFromActiveInterrupt,
  askTimelineItemFromToolPart,
} from './project-ask-user-question-parts'
import {
  isAskUserQuestionToolPart,
  isDelegateTaskToolPart,
  isProjectToolTimelinePart,
  projectAssistantPartFromAssistantPart,
  projectUserMessageFromAssistantMessage,
  rawToolNameFromProjectToolPart,
} from './project-message-parts'

/**
 * 从委派工具输入中读取用户可见的子 agent 名称。
 *
 * @param input - delegate_task_to_member 工具输入。
 * @returns 可展示的成员名称。
 */
export const subagentTargetLabelFromDelegateInput = (input: unknown) => {
  if (!isRecord(input)) {
    return '协作成员'
  }

  const memberId = stringField(input, 'member_id')

  return SUBAGENT_LABELS_BY_MEMBER_ID[memberId] ?? '协作成员'
}

/**
 * 从委派工具输入中读取 assistant response shell 的 speaker。
 *
 * @param input - delegate_task_to_member 工具输入。
 * @returns 已知子 agent 返回对应身份；未知成员降级为制片人。
 */
export const assistantAgentKindFromDelegateInput = (
  input: unknown,
): ProjectAssistantBubbleAgentKind => {
  if (!isRecord(input)) {
    return PROJECT_ASSISTANT_DEFAULT_AGENT_KIND
  }

  const memberId = stringField(input, 'member_id')

  return SUBAGENT_AGENT_KIND_BY_MEMBER_ID[memberId] ?? PROJECT_ASSISTANT_DEFAULT_AGENT_KIND
}

/**
 * 判断委派工具 part 是否已经到达终态。
 *
 * @param part - delegate_task_to_member 工具 part。
 * @returns 工具完成或失败时返回 true。
 */
export const isTerminalSubagentToolPart = (part: ProjectGenericToolPart) =>
  part.state === 'output-available' || part.state === 'output-error'

/**
 * 根据子 agent 委派状态推导后续 response shell speaker。
 *
 * @param part - delegate_task_to_member 工具 part。
 * @returns 子 agent 运行中返回目标身份；终态或未知成员返回制片人。
 */
export const activeAgentKindAfterSubagentToolPart = (
  part: ProjectGenericToolPart,
): ProjectAssistantBubbleAgentKind =>
  isTerminalSubagentToolPart(part)
    ? PROJECT_ASSISTANT_DEFAULT_AGENT_KIND
    : assistantAgentKindFromDelegateInput(part.input)

/**
 * 将委派工具状态转换为用户可见事件。
 *
 * @param params - 子 agent 事件参数。
 * @param params.invocationId - 当前子 agent 调用在消息中的本地 id。
 * @param params.part - delegate_task_to_member 工具 part。
 * @param params.targetLabel - 用户可见的子 agent 名称。
 * @returns 按交接、完成顺序排列的流程事件。
 */
export const subagentFlowEventsFromToolPart = ({
  invocationId,
  part,
  targetLabel,
}: {
  invocationId: string
  part: ProjectGenericToolPart
  targetLabel: string
}): ProjectSubagentFlowEvent[] => {
  const events: ProjectSubagentFlowEvent[] = [
    {
      id: `${invocationId}:started`,
      label: `制片人将任务交给${targetLabel}`,
      status: 'started',
    },
  ]

  if (part.state === 'output-available') {
    events.push({
      id: `${invocationId}:completed`,
      label: `${targetLabel}已完成任务`,
      status: 'completed',
    })
  }

  if (part.state === 'output-error') {
    events.push({
      id: `${invocationId}:failed`,
      label: `${targetLabel}任务失败`,
      status: 'failed',
    })
  }

  return events
}

/**
 * 从 delegate_task_to_member 工具 part 创建子 agent timeline item。
 *
 * @param params - 子 agent timeline 参数。
 * @param params.invocationId - 当前子 agent 调用在消息中的本地 id。
 * @param params.part - delegate_task_to_member 工具 part。
 * @returns 可渲染的子 agent 流程 item。
 */
export const subagentTimelineItemFromToolPart = ({
  invocationId,
  part,
  segments,
}: {
  invocationId: string
  part: ProjectGenericToolPart
  segments?: ProjectMemberSegment[]
}): ProjectSubagentFlowTimelineItem => {
  const targetLabel = subagentTargetLabelFromDelegateInput(part.input)

  return {
    events: subagentFlowEventsFromToolPart({
      invocationId,
      part,
      targetLabel,
    }),
    id: `subagent:${invocationId}`,
    kind: 'subagent-flow',
    ...(segments && segments.length > 0 ? { segments } : {}),
    targetLabel,
    toolCallId: part.toolCallId,
  }
}

/**
 * 按 delegate 工具调用 id 建立成员段索引。
 *
 * @param memberSegments - restore 与 live 汇总出的成员段。
 * @returns ``parentToolCallId`` → 成员段列表（保持发生顺序）。
 */
export const memberSegmentsByParentToolCallId = (
  memberSegments: readonly ProjectMemberSegment[],
) => {
  const segmentsByToolCallId = new Map<string, ProjectMemberSegment[]>()

  for (const segment of memberSegments) {
    if (!segment.parentToolCallId) {
      continue
    }

    const existing = segmentsByToolCallId.get(segment.parentToolCallId)

    if (existing) {
      existing.push(segment)
      continue
    }

    segmentsByToolCallId.set(segment.parentToolCallId, [segment])
  }

  return segmentsByToolCallId
}

export interface ProjectTimelineBuildCursor {
  activeAgentKind: ProjectAssistantBubbleAgentKind
  assistantItem: ProjectAssistantBubbleTimelineItem | null
  toolSegmentItem: ProjectToolLogSegmentTimelineItem | null
}

/**
 * 创建 timeline 构建游标的初始状态。
 *
 * @returns 默认以制片人为 active speaker 的构建游标。
 */
export const createProjectTimelineBuildCursor = (): ProjectTimelineBuildCursor => ({
  activeAgentKind: PROJECT_ASSISTANT_DEFAULT_AGENT_KIND,
  assistantItem: null,
  toolSegmentItem: null,
})

/**
 * 从 assistant-ui 消息创建 Producer 消息元数据。
 *
 * @param message - assistant-ui assistant message。
 * @returns 可写入 Producer message 的元数据。
 */
export const projectMessageMetadataFromAssistantMessage = (
  message: ThreadMessage,
): ProjectMessageMetadata => ({
  createdAt: message.createdAt.getTime(),
})

/**
 * 创建同一消息内稳定唯一的 timeline 段 id。
 *
 * @param params - timeline 段 id 参数。
 * @param params.kind - timeline 段类型。
 * @param params.message - 当前 assistant-ui 消息。
 * @param params.partIndex - 段起始 part 在当前消息内的位置。
 * @returns 由后端消息 id 和段起始位置组成的唯一 id。
 */
export const createProjectTimelineSegmentId = ({
  kind,
  message,
  partIndex,
}: {
  kind: 'assistant' | 'tools'
  message: ThreadMessage
  partIndex: number
}) => `${kind}:${message.id}:${partIndex.toString(36)}`

/**
 * 结束当前可见 assistant 气泡连续段。
 *
 * @param cursor - 当前 timeline 写入游标。
 */
export const flushAssistantBubbleSegment = (cursor: ProjectTimelineBuildCursor) => {
  cursor.assistantItem = null
}

/**
 * 结束当前普通工具日志连续段。
 *
 * @param cursor - 当前 timeline 写入游标。
 */
export const flushToolLogSegment = (cursor: ProjectTimelineBuildCursor) => {
  cursor.toolSegmentItem = null
}

/**
 * 将可见 assistant part 写入连续 timeline。
 *
 * @param params - 写入参数。
 * @param params.cursor - 当前 timeline 写入游标。
 * @param params.items - 正在构建的连续 timeline items。
 * @param params.message - assistant-ui assistant message。
 * @param params.part - Producer 可见消息 part。
 * @param params.partIndex - part 在 assistant-ui 消息中的位置。
 */
export const appendAssistantBubblePartToTimeline = ({
  cursor,
  items,
  message,
  part,
  partIndex,
}: {
  cursor: ProjectTimelineBuildCursor
  items: ProjectChatTimelineItem[]
  message: ThreadMessage
  part: ProjectMessagePart
  partIndex: number
}) => {
  flushToolLogSegment(cursor)

  if (!cursor.assistantItem) {
    const segmentId = createProjectTimelineSegmentId({
      kind: 'assistant',
      message,
      partIndex,
    })

    cursor.assistantItem = {
      agentKind: cursor.activeAgentKind,
      id: segmentId,
      kind: 'assistant-bubble',
      message: {
        id: segmentId,
        metadata: projectMessageMetadataFromAssistantMessage(message),
        parts: [],
        role: 'assistant',
      },
    }
    items.push(cursor.assistantItem)
  }

  cursor.assistantItem.message = {
    ...cursor.assistantItem.message,
    parts: [...cursor.assistantItem.message.parts, part],
  }
}

/**
 * 将普通工具日志写入连续 timeline。
 *
 * @param params - 写入参数。
 * @param params.cursor - 当前 timeline 写入游标。
 * @param params.items - 正在构建的连续 timeline items。
 * @param params.message - assistant-ui assistant message。
 * @param params.part - Producer 工具消息 part。
 * @param params.partIndex - part 在 assistant-ui 消息中的位置。
 */
export const appendToolLogPartToTimeline = ({
  cursor,
  items,
  message,
  part,
  partIndex,
}: {
  cursor: ProjectTimelineBuildCursor
  items: ProjectChatTimelineItem[]
  message: ThreadMessage
  part: ProjectGenericToolPart
  partIndex: number
}) => {
  flushAssistantBubbleSegment(cursor)
  cursor.activeAgentKind = PROJECT_ASSISTANT_DEFAULT_AGENT_KIND

  if (!cursor.toolSegmentItem) {
    cursor.toolSegmentItem = {
      id: createProjectTimelineSegmentId({
        kind: 'tools',
        message,
        partIndex,
      }),
      kind: 'tool-log-segment',
      logs: [],
      toolStates: [],
    }
    items.push(cursor.toolSegmentItem)
  }

  cursor.toolSegmentItem.toolStates = [
    ...cursor.toolSegmentItem.toolStates,
    {
      rawToolName: rawToolNameFromProjectToolPart(part),
      ...(part.state ? { state: part.state } : {}),
      toolCallId: part.toolCallId,
    },
  ]

  const entry = projectToolLogEntryFromMessagePart({
    messageMetadata: projectMessageMetadataFromAssistantMessage(message),
    part,
  })

  if (!entry) {
    return
  }

  cursor.toolSegmentItem.logs = upsertProjectToolLogEntry({
    entry,
    logs: cursor.toolSegmentItem.logs,
  })
}

/**
 * 合并同 id 的特殊 timeline item。
 *
 * @param existing - 当前已经写入的 timeline item。
 * @param incoming - 准备写入的新 timeline item。
 * @returns 可保留历史回答和最新状态的合并结果。
 */
export const mergeProjectTimelineItem = (
  existing: ProjectChatTimelineItem,
  incoming: ProjectChatTimelineItem,
): ProjectChatTimelineItem => {
  if (existing.kind === 'ask-user-question' && incoming.kind === 'ask-user-question') {
    return {
      ...incoming,
      response: incoming.response ?? existing.response,
    }
  }

  return incoming
}

/**
 * 将特殊工具 timeline item 写入连续 timeline。
 *
 * @param params - 写入参数。
 * @param params.cursor - 当前 timeline 写入游标。
 * @param params.item - 特殊工具 timeline item。
 * @param params.items - 正在构建的连续 timeline items。
 */
export const appendSpecialTimelineItemToTimeline = ({
  cursor,
  item,
  items,
}: {
  cursor: ProjectTimelineBuildCursor
  item: ProjectChatTimelineItem | null
  items: ProjectChatTimelineItem[]
}) => {
  flushAssistantBubbleSegment(cursor)
  flushToolLogSegment(cursor)

  if (!item) {
    return
  }

  const existingIndex = items.findIndex((currentItem) => currentItem.id === item.id)

  if (existingIndex < 0) {
    items.push(item)
    return
  }

  // findIndex 命中保证下标有效。
  items[existingIndex] = mergeProjectTimelineItem(items[existingIndex]!, item)
}

/**
 * 判断消息 part 是否能让 assistant bubble 成为真实回复内容。
 *
 * @param part - Producer 消息 part。
 * @returns 文本、推理或文件有可见内容时返回 true。
 */
export const isRenderableAssistantBubblePart = (part: ProjectMessagePart) => {
  if (part.type === 'text' || part.type === 'reasoning') {
    return part.text.trim().length > 0
  }

  return part.type === 'file'
}

/**
 * 判断 assistant bubble 是否已经承载真实回复内容。
 *
 * @param item - assistant-bubble timeline item。
 * @returns 包含可见 text、reasoning 或 file part 时返回 true。
 */
export const assistantBubbleHasRenderableContent = (item: ProjectAssistantBubbleTimelineItem) =>
  item.message.parts.some(isRenderableAssistantBubblePart)

/**
 * 判断 timeline item 是否会产生可见聊天节点。
 *
 * @param item - 已投影出的 timeline item。
 * @returns item 会被聊天面板渲染为可见节点时返回 true。
 */
export const isVisibleProjectTimelineItem = (item: ProjectChatTimelineItem) => {
  if (item.kind === 'assistant-bubble') {
    return item.isResponseShell === true || assistantBubbleHasRenderableContent(item)
  }

  if (item.kind === 'tool-log-segment') {
    return item.logs.length > 0
  }

  if (item.kind === 'subagent-flow') {
    return item.events.length > 0
  }

  return true
}

/**
 * 读取连续 timeline 中最后一个可见节点。
 *
 * @param items - 已投影出的 timeline items。
 * @returns 最新可见节点；没有可见节点时返回 null。
 */
export const latestVisibleProjectTimelineItem = (items: ProjectChatTimelineItem[]) => {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]

    if (item && isVisibleProjectTimelineItem(item)) {
      return item
    }
  }

  return null
}

/**
 * 创建 active run 等待态使用的 assistant response shell。
 *
 * @param agentKind - 当前 response shell 应展示的 speaker 身份。
 * @returns 空 parts 的 assistant-bubble timeline item。
 */
export const createAssistantResponseShellTimelineItem = (
  agentKind: ProjectAssistantBubbleAgentKind,
): ProjectAssistantBubbleTimelineItem => ({
  agentKind,
  id: PROJECT_ASSISTANT_RESPONSE_SHELL_ID,
  isResponseShell: true,
  kind: 'assistant-bubble',
  message: {
    id: PROJECT_ASSISTANT_RESPONSE_SHELL_ID,
    parts: [],
    role: 'assistant',
  },
})

/**
 * 在 active run 期间插入或标记单一 assistant response shell。
 *
 * @param params - response shell 解析参数。
 * @param params.activeAgentKind - 当前 active speaker 身份。
 * @param params.activeInterrupt - 当前 Producer HITL 中断。
 * @param params.isRunning - 当前 assistant-ui 线程是否仍在运行。
 * @param params.items - 已投影出的 timeline items。
 */
export const resolveActiveResponseShellTimeline = ({
  activeAgentKind,
  activeInterrupt,
  isRunning,
  items,
}: {
  activeAgentKind: ProjectAssistantBubbleAgentKind
  activeInterrupt: ProjectChatInterrupt | null
  isRunning: boolean
  items: ProjectChatTimelineItem[]
}) => {
  if (!isRunning || items.length === 0) {
    return
  }

  const latestVisibleItem = latestVisibleProjectTimelineItem(items)

  if (!latestVisibleItem) {
    return
  }

  if (
    latestVisibleItem.kind === 'ask-user-question' &&
    activeInterrupt?.kind === 'ask_user_question' &&
    activeInterrupt.targetId === latestVisibleItem.toolCallId
  ) {
    return
  }

  if (latestVisibleItem.kind === 'assistant-bubble') {
    latestVisibleItem.isResponseShell = true
    return
  }

  items.push(createAssistantResponseShellTimelineItem(activeAgentKind))
}

/**
 * 将 assistant-ui runtime messages 转换为 Producer 连续聊天 timeline。
 *
 * @param params - timeline 转换参数。
 * @param params.activeInterrupt - 当前 Producer HITL 中断。
 * @param params.isRunning - 当前 assistant-ui 线程是否仍在运行。
 * @param params.messages - assistant-ui runtime messages。
 * @returns 按后端消息 id 和工具调用 id 生成的连续 timeline items。
 */
export const projectConversationTimelineItemsFromAssistantMessages = ({
  activeInterrupt,
  isRunning,
  memberSegments = [],
  messages,
}: ProjectAssistantTimelineInput) => {
  const items: ProjectChatTimelineItem[] = []
  const segmentsByToolCallId = memberSegmentsByParentToolCallId(memberSegments)
  let cursor = createProjectTimelineBuildCursor()

  for (const message of messages) {
    if (message.role === 'user') {
      flushAssistantBubbleSegment(cursor)
      flushToolLogSegment(cursor)
      cursor = createProjectTimelineBuildCursor()
      items.push({
        id: `user:${message.id}`,
        kind: 'user-message',
        message: projectUserMessageFromAssistantMessage(message),
      })
      continue
    }

    if (message.role !== 'assistant') {
      continue
    }

    for (const [partIndex, part] of message.content.entries()) {
      if (part.type === 'tool-call' && isSyntheticConfirmToolCallPart(part)) {
        continue
      }

      const projectPart = projectAssistantPartFromAssistantPart({
        message,
        part: part,
      })

      if (!projectPart) {
        continue
      }

      if (isProjectToolTimelinePart(projectPart)) {
        if (isAskUserQuestionToolPart(projectPart)) {
          appendSpecialTimelineItemToTimeline({
            cursor,
            items,
            item: askTimelineItemFromToolPart({
              activeInterrupt,
              part: projectPart,
            }),
          })
          cursor.activeAgentKind = PROJECT_ASSISTANT_DEFAULT_AGENT_KIND
          continue
        }

        if (isDelegateTaskToolPart(projectPart)) {
          const invocationId = `${message.id}:${partIndex.toString(36)}`

          appendSpecialTimelineItemToTimeline({
            cursor,
            items,
            item: subagentTimelineItemFromToolPart({
              invocationId,
              part: projectPart,
              segments: segmentsByToolCallId.get(projectPart.toolCallId),
            }),
          })
          cursor.activeAgentKind = activeAgentKindAfterSubagentToolPart(projectPart)
          continue
        }

        appendToolLogPartToTimeline({
          cursor,
          items,
          message,
          part: projectPart,
          partIndex,
        })
        continue
      }

      appendAssistantBubblePartToTimeline({
        cursor,
        items,
        message,
        part: projectPart,
        partIndex,
      })
    }
  }

  appendActiveAskInterruptToTimeline({
    activeInterrupt,
    cursor,
    items,
  })

  resolveActiveResponseShellTimeline({
    activeAgentKind: cursor.activeAgentKind,
    activeInterrupt,
    isRunning,
    items,
  })

  return items
}

/**
 * 创建发送给 assistant-ui runtime 的 Producer user message。
 *
 * 文本与媒体按 chip 位置交错进入 content；媒体只活在 content 里，
 * attachments 恒空——两处都放会导致重复发送。
 *
 * @param input - user message 构造参数。
 * @param input.parts - 已准备好远端 URL 的有序消息 part。
 * @returns 可直接传给 assistant-ui thread.append 的消息。
 */
export const createProjectAssistantUserMessage = ({
  parts,
}: ProjectAssistantUserMessageInput): CreateAppendMessage => ({
  attachments: [],
  content: parts.map((part) =>
    part.type === 'text'
      ? { text: part.text, type: 'text' as const }
      : {
          data: part.url,
          mimeType: part.mediaType,
          type: 'file' as const,
          ...(part.filename ? { filename: part.filename } : {}),
        },
  ),
  createdAt: new Date(),
  parentId: null,
  role: 'user',
  sourceId: null,
  startRun: true,
})

/**
 * 确保当前 ask interrupt 在 timeline 中有一个可挂载面板的位置。
 *
 * @param params - 写入参数。
 * @param params.activeInterrupt - 当前 Producer 中断。
 * @param params.cursor - 当前 timeline 写入游标。
 * @param params.items - 正在构建的连续 timeline items。
 */
export const appendActiveAskInterruptToTimeline = ({
  activeInterrupt,
  cursor,
  items,
}: {
  activeInterrupt: ProjectChatInterrupt | null
  cursor: ProjectTimelineBuildCursor
  items: ProjectChatTimelineItem[]
}) => {
  if (activeInterrupt?.kind !== 'ask_user_question') {
    return
  }

  const hasActiveAskItem = items.some(
    (item) => item.kind === 'ask-user-question' && item.toolCallId === activeInterrupt.targetId,
  )

  if (hasActiveAskItem) {
    return
  }

  appendSpecialTimelineItemToTimeline({
    cursor,
    item: askTimelineItemFromActiveInterrupt(activeInterrupt),
    items,
  })
}
