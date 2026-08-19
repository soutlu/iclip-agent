import type {
  ThreadAssistantMessagePart,
  ThreadMessage,
  ThreadUserMessagePart,
  ToolCallMessagePart,
} from '@assistant-ui/react'
import type {
  ProjectFilePart,
  ProjectGenericToolPart,
  ProjectMessagePart,
  ProjectUIMessage,
} from '@/features/chat/contracts'
import {
  ASK_USER_QUESTION_TOOL_NAME,
  DELEGATE_TASK_TO_MEMBER_TOOL_NAME,
  isSyntheticConfirmToolCallPart,
} from './project-agui-messages'

/**
 * 将项目 file part 转换为 user bubble 可展示的项目消息 part。
 *
 * @param part - assistant-ui user message part 或附件 part。
 * @returns Producer 项目消息 file part；不支持时返回 null。
 */
export const projectFilePartFromAssistantPart = (
  part: ThreadUserMessagePart,
): ProjectFilePart | null => {
  if (part.type === 'image') {
    return {
      ...(part.filename ? { filename: part.filename } : {}),
      mediaType: 'image/*',
      type: 'file',
      url: part.image,
    }
  }

  if (part.type === 'file') {
    return {
      ...(part.filename ? { filename: part.filename } : {}),
      mediaType: part.mimeType,
      type: 'file',
      url: part.data,
    }
  }

  return null
}

/**
 * 从 assistant-ui user message 附件读取 file parts（存量扁平消息形态）。
 *
 * @param message - assistant-ui user message。
 * @returns Producer 可展示的附件 file parts。
 */
const projectFilePartsFromLegacyAttachments = (message: ThreadMessage) =>
  message.role === 'user'
    ? message.attachments.flatMap((attachment) =>
        attachment.content
          .map(projectFilePartFromAssistantPart)
          .filter((part): part is ProjectFilePart => part !== null),
      )
    : []

/**
 * 将 assistant-ui user message 转换为 Producer user message。
 *
 * content 的文本/媒体交错顺序原样保留（位置语义）；存量扁平消息的附件
 * file parts 置于最前，与其原发送形态一致。
 *
 * @param message - assistant-ui user message。
 * @returns Producer 聊天 UI 使用的 user message。
 */
export const projectUserMessageFromAssistantMessage = (
  message: ThreadMessage,
): ProjectUIMessage => {
  const orderedParts = message.content.flatMap((part): ProjectMessagePart[] => {
    if (part.type === 'text') {
      return part.text.trim().length > 0 ? [{ text: part.text, type: 'text' }] : []
    }

    const filePart = projectFilePartFromAssistantPart(part as ThreadUserMessagePart)
    return filePart ? [filePart] : []
  })

  return {
    id: message.id,
    metadata: {
      createdAt: message.createdAt.getTime(),
    },
    parts: [...projectFilePartsFromLegacyAttachments(message), ...orderedParts],
    role: 'user',
  }
}

/**
 * 根据 assistant-ui tool-call part 推导 Producer 工具状态。
 *
 * @param params - 工具状态推导参数。
 * @param params.message - part 所属 assistant message。
 * @param params.part - assistant-ui tool-call part。
 * @returns Producer tool part 使用的状态字符串。
 */
export const projectToolStateFromAssistantPart = ({
  message,
  part,
}: {
  message: ThreadMessage
  part: ToolCallMessagePart
}) => {
  if (part.isError) {
    return 'output-error'
  }

  if ('result' in part && part.result !== undefined) {
    return 'output-available'
  }

  return message.status?.type === 'running' ? 'input-streaming' : 'input-available'
}

/**
 * 将工具调用结果规整为可读错误文本，避免对象被字符串化成 "[object Object]"。
 *
 * @param result - 工具调用结果。
 * @returns 可读错误文本。
 */
export const toolCallErrorText = (result: unknown): string => {
  if (typeof result === 'string') {
    return result
  }

  if (
    typeof result === 'object' &&
    result !== null &&
    'message' in result &&
    typeof result.message === 'string' &&
    result.message.trim()
  ) {
    return result.message
  }

  if (result == null) {
    return '工具执行失败'
  }

  return JSON.stringify(result) ?? '工具执行失败'
}

/**
 * 将 assistant-ui tool-call part 转换为 Producer 工具消息 part。
 *
 * @param params - 工具 part 转换参数。
 * @param params.message - tool-call 所属 assistant message。
 * @param params.part - assistant-ui assistant message part。
 * @returns Producer 工具消息 part。
 */
export const projectToolPartFromAssistantToolCall = ({
  message,
  part,
}: {
  message: ThreadMessage
  part: ToolCallMessagePart
}): ProjectMessagePart => {
  return {
    errorText: part.isError ? toolCallErrorText(part.result) : undefined,
    input: part.args,
    output: part.result,
    state: projectToolStateFromAssistantPart({
      message,
      part,
    }),
    toolCallId: part.toolCallId,
    type: `tool-${part.toolName}`,
  }
}

/**
 * 将 assistant-ui assistant message part 转换为 Producer message part。
 *
 * @param params - assistant part 转换参数。
 * @param params.message - part 所属 assistant message。
 * @param params.part - assistant-ui assistant message part。
 * @returns Producer 可渲染的 message part；不支持时返回 null。
 */
export const projectAssistantPartFromAssistantPart = ({
  message,
  part,
}: {
  message: ThreadMessage
  part: ThreadAssistantMessagePart
}): ProjectMessagePart | null => {
  if (part.type === 'text') {
    return {
      text: part.text,
      type: 'text',
    }
  }

  if (part.type === 'reasoning') {
    return {
      text: part.text,
      type: 'reasoning',
    }
  }

  if (part.type === 'tool-call') {
    return isSyntheticConfirmToolCallPart(part)
      ? null
      : projectToolPartFromAssistantToolCall({
          message,
          part,
        })
  }

  if (part.type === 'file') {
    return {
      ...(part.filename ? { filename: part.filename } : {}),
      mediaType: part.mimeType,
      type: 'file',
      url: part.data,
    }
  }

  if (part.type === 'image') {
    return {
      mediaType: 'image/*',
      type: 'file',
      url: part.image,
    }
  }

  return null
}

/**
 * 判断项目消息 part 是否是 assistant 工具 part。
 *
 * @param part - 需要检查的项目消息 part。
 * @returns 通用工具 part 返回 true。
 */
export const isProjectToolTimelinePart = (
  part: ProjectMessagePart,
): part is ProjectGenericToolPart => part.type.startsWith('tool-')

/**
 * 从项目工具 part 中读取原始工具名。
 *
 * @param part - 项目工具 part。
 * @returns 去掉 tool- 前缀后的工具名。
 */
export const rawToolNameFromProjectToolPart = (part: ProjectGenericToolPart) =>
  part.type.slice('tool-'.length)

/**
 * 判断项目工具 part 是否是 ask_user_question。
 *
 * @param part - 项目工具 part。
 * @returns ask_user_question 工具返回 true。
 */
export const isAskUserQuestionToolPart = (part: ProjectGenericToolPart) =>
  rawToolNameFromProjectToolPart(part) === ASK_USER_QUESTION_TOOL_NAME

/**
 * 判断项目工具 part 是否是子 agent 委派。
 *
 * @param part - 项目工具 part。
 * @returns delegate_task_to_member 工具返回 true。
 */
export const isDelegateTaskToolPart = (part: ProjectGenericToolPart) =>
  rawToolNameFromProjectToolPart(part) === DELEGATE_TASK_TO_MEMBER_TOOL_NAME
