import type { Message } from '@ag-ui/client'
import type {
  ThreadAssistantMessagePart,
  ThreadMessage,
  ThreadMessageLike,
  ToolCallMessagePart,
} from '@assistant-ui/react'
import { fromAgUiMessages } from '@assistant-ui/react-ag-ui'
import type {
  ProjectAssistantBubbleAgentKind,
  ProjectChatInterrupt,
  ProjectMemberSegment,
} from '@/features/chat/contracts'
import { isRecord } from '@/shared/lib/guards'
import type { PreparedComposerMessagePart } from '@/shared/composer'

export const ASK_USER_QUESTION_TOOL_NAME = 'ask_user_question'
const CONFIRM_TOOL_CALL_PREFIX = 'confirm_'
const CONFIRM_TOOL_NAME = 'confirm'
export const DELEGATE_TASK_TO_MEMBER_TOOL_NAME = 'delegate_task_to_member'
export const PROJECT_ASSISTANT_RESPONSE_SHELL_ID = 'assistant:response-shell'
export const PROJECT_ASSISTANT_DEFAULT_AGENT_KIND =
  'producer' satisfies ProjectAssistantBubbleAgentKind
export const SUBAGENT_LABELS_BY_MEMBER_ID: Record<string, string> = {
  'creative-director': '创意策划师',
  'storyboard-director': '分镜执行导演',
}
export const SUBAGENT_AGENT_KIND_BY_MEMBER_ID: Record<string, ProjectAssistantBubbleAgentKind> = {
  'creative-director': 'creative-director',
  'storyboard-director': 'storyboard',
}

export interface ProjectAssistantUserMessageInput {
  parts: readonly PreparedComposerMessagePart[]
}

export interface ProjectAssistantTimelineInput {
  activeInterrupt: ProjectChatInterrupt | null
  isRunning: boolean
  memberSegments?: readonly ProjectMemberSegment[]
  messages: readonly ThreadMessage[]
}

/**
 * 读取并规整字符串字段。
 *
 * @param value - 需要读取的未知字段值。
 * @returns 去除空白后的非空字符串；无效时返回空字符串。
 */
export const stringValue = (value: unknown) =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : ''

/**
 * 解析可能是 JSON 字符串的结构化值。
 *
 * @param value - AG-UI 工具参数或结果文本。
 * @returns JSON 解析成功时返回结构化值；否则返回原始字符串或 undefined。
 */
export const parseStructuredValue = (value: string | undefined) => {
  const rawValue = value?.trim() ?? ''

  if (rawValue.length === 0) {
    return undefined
  }

  try {
    return JSON.parse(rawValue) as unknown
  } catch {
    return rawValue
  }
}

/**
 * 判断工具调用是否是 Producer 内部确认工具。
 *
 * @param params - 工具调用识别参数。
 * @param params.toolCallId - AG-UI 工具调用 id。
 * @param params.toolName - AG-UI 工具名。
 * @returns 工具调用仅用于确认协议时返回 true。
 */
const isSyntheticConfirmToolCall = ({
  toolCallId,
  toolName,
}: {
  toolCallId: string
  toolName: string
}) => toolName === CONFIRM_TOOL_NAME || toolCallId.startsWith(CONFIRM_TOOL_CALL_PREFIX)

/**
 * 判断 assistant-ui tool-call part 是否只用于 Producer 内部确认协议。
 *
 * @param part - assistant-ui tool-call message part。
 * @returns 内部确认工具返回 true。
 */
export const isSyntheticConfirmToolCallPart = (part: ToolCallMessagePart) =>
  isSyntheticConfirmToolCall({
    toolCallId: part.toolCallId,
    toolName: part.toolName,
  })

/**
 * 为转换期间的重复 delegate toolCallId 生成成员作用域 id。
 *
 * @param params - 原始工具调用 id 与成员 id。
 * @returns 只在调用官方转换器期间使用的唯一 id。
 */
const delegateMemberScopeId = ({
  memberId,
  toolCallId,
}: {
  memberId: string
  toolCallId: string
}) => `__project_delegate__:${JSON.stringify([toolCallId, memberId])}`

/**
 * 从 delegate_task_to_member 调用参数读取成员 id。
 *
 * @param toolCall - AG-UI assistant tool call。
 * @returns delegate 成员 id；非 delegate 或参数非法时返回空字符串。
 */
const delegateMemberIdFromToolCall = (toolCall: Record<string, unknown>) => {
  const functionData = isRecord(toolCall.function) ? toolCall.function : null
  if (!functionData || stringValue(functionData.name) !== DELEGATE_TASK_TO_MEMBER_TOOL_NAME) {
    return ''
  }

  const argumentsValue =
    typeof functionData.arguments === 'string'
      ? parseStructuredValue(functionData.arguments)
      : functionData.arguments

  return isRecord(argumentsValue) ? stringField(argumentsValue, 'member_id') : ''
}

/**
 * 将 AG-UI 原始消息快照转换为 assistant-ui thread messages。
 *
 * @param messages - 后端返回的 AG-UI 原始消息。
 * @returns assistant-ui runtime 可导入的消息列表。
 */
export const assistantMessagesFromAguiMessages = (
  messages: readonly Message[],
): ThreadMessageLike[] => {
  const originalToolCallIdByScopedId = new Map<string, string>()
  for (const rawMessage of messages) {
    const message = rawMessage as Message & Record<string, unknown>
    if (message.role !== 'assistant' || !Array.isArray(message.toolCalls)) {
      continue
    }

    for (const toolCall of message.toolCalls) {
      if (!isRecord(toolCall)) {
        continue
      }

      const toolCallId = stringValue(toolCall.id)
      const memberId = delegateMemberIdFromToolCall(toolCall)
      if (toolCallId !== '' && memberId !== '') {
        originalToolCallIdByScopedId.set(
          delegateMemberScopeId({ memberId, toolCallId }),
          toolCallId,
        )
      }
    }
  }

  const latestConfirmationByToolCallId = new Map<string, boolean>()
  const scopedMessages = messages.flatMap((rawMessage): Message[] => {
    const message = rawMessage as Message & Record<string, unknown>
    if (message.role === 'assistant' && Array.isArray(message.toolCalls)) {
      return [
        {
          ...message,
          toolCalls: message.toolCalls.flatMap((toolCall) => {
            if (!isRecord(toolCall)) {
              return [toolCall]
            }

            const toolCallId = stringValue(toolCall.id)
            const functionData = isRecord(toolCall.function) ? toolCall.function : null
            const toolName = functionData ? stringValue(functionData.name) : ''
            const isConfirmation = isSyntheticConfirmToolCall({ toolCallId, toolName })
            if (toolCallId !== '') {
              latestConfirmationByToolCallId.set(toolCallId, isConfirmation)
            }
            if (isConfirmation) {
              return []
            }

            const scopedId = delegateMemberScopeId({
              memberId: delegateMemberIdFromToolCall(toolCall),
              toolCallId,
            })
            return [
              originalToolCallIdByScopedId.has(scopedId) ? { ...toolCall, id: scopedId } : toolCall,
            ]
          }),
        },
      ]
    }

    if (message.role === 'tool') {
      const toolCallId = stringValue(message.toolCallId)
      if (latestConfirmationByToolCallId.get(toolCallId) === true) {
        return []
      }

      if (isRecord(message.toolArgs)) {
        const scopedId = delegateMemberScopeId({
          memberId: stringField(message.toolArgs, 'member_id'),
          toolCallId,
        })
        if (originalToolCallIdByScopedId.has(scopedId)) {
          return [{ ...message, toolCallId: scopedId }]
        }
      }
    }

    return [rawMessage]
  })

  const delegateResultsByScopedId = new Map<string, Message[]>()
  for (const rawMessage of scopedMessages) {
    const message = rawMessage as Message & Record<string, unknown>
    const scopedId = message.role === 'tool' ? stringValue(message.toolCallId) : ''
    if (!originalToolCallIdByScopedId.has(scopedId)) {
      continue
    }

    const results = delegateResultsByScopedId.get(scopedId) ?? []
    results.push(rawMessage)
    delegateResultsByScopedId.set(scopedId, results)
  }

  // 官方按消息流向后匹配 result；成员 result 可能先于对应 leader message 被持久化。
  const orderedMessages = scopedMessages.flatMap((rawMessage): Message[] => {
    const message = rawMessage as Message & Record<string, unknown>
    if (
      message.role === 'tool' &&
      originalToolCallIdByScopedId.has(stringValue(message.toolCallId))
    ) {
      return []
    }
    if (message.role !== 'assistant' || !Array.isArray(message.toolCalls)) {
      return [rawMessage]
    }

    const delegateResults = message.toolCalls.flatMap((toolCall) => {
      const scopedId = isRecord(toolCall) ? stringValue(toolCall.id) : ''
      return delegateResultsByScopedId.get(scopedId) ?? []
    })
    return [rawMessage, ...delegateResults]
  })

  const assistantMessageIds = new Set<string>()
  for (const rawMessage of messages) {
    const message = rawMessage as Message & Record<string, unknown>
    const messageId = stringValue(message.id)
    if ((message.role === 'assistant' || message.role === 'reasoning') && messageId !== '') {
      assistantMessageIds.add(messageId)
    }
  }

  const orphanToolMessageIds = new Set<string>()
  for (const rawMessage of orderedMessages) {
    const message = rawMessage as Message & Record<string, unknown>
    if (message.role !== 'tool') {
      continue
    }

    const sourceId = stringValue(message.id) || stringValue(message.toolCallId)
    if (sourceId !== '') {
      orphanToolMessageIds.add(`${sourceId}:assistant`)
    }
  }

  return fromAgUiMessages(orderedMessages).flatMap((message): ThreadMessageLike[] => {
    const messageId = stringValue(message.id)
    if (message.role !== 'assistant') {
      return [message]
    }
    if (
      messageId !== '' &&
      orphanToolMessageIds.has(messageId) &&
      !assistantMessageIds.has(messageId)
    ) {
      return []
    }

    const content = Array.isArray(message.content)
      ? (message.content as readonly ThreadAssistantMessagePart[]).flatMap(
          (part): ThreadAssistantMessagePart[] => {
            if (part.type !== 'tool-call') {
              return [part]
            }
            const originalToolCallId = originalToolCallIdByScopedId.get(part.toolCallId)
            return originalToolCallId ? [{ ...part, toolCallId: originalToolCallId }] : [part]
          },
        )
      : message.content

    return [
      {
        ...message,
        content,
      },
    ]
  })
}

/**
 * 读取对象中的字符串字段。
 *
 * @param record - 需要读取的对象。
 * @param key - 字段名。
 * @returns 字段存在且为非空字符串时返回规整文本。
 */
export const stringField = (record: Record<string, unknown>, key: string) =>
  stringValue(record[key])
