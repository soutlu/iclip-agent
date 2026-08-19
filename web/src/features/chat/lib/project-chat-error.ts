export const BACKEND_AGENT_RUNTIME_ERROR_MESSAGE = 'agent运行错误'
export const CHAT_INTERFACE_NOT_READY_MESSAGE = '聊天接口尚未接入，AI SDK 已移除。'
export const HITL_CONTINUATION_STREAM_INTERRUPTED_MESSAGE =
  '续跑已提交，但实时连接已中断；请稍后刷新，从已保存的会话恢复结果。'
export const WAITING_FOR_CONTINUATION_REQUEST_ERROR_MESSAGE =
  '当前交互正在等待你的确认或补充信息，请先完成当前交互后再发送新消息。'

type ProjectChatErrorKind = 'attachment' | 'backend' | 'request'

export interface ClassifiedProjectChatError {
  kind: ProjectChatErrorKind
  message: string
}

const GENERIC_REQUEST_ERROR_MESSAGE = '连接聊天服务失败，请重试。'
const ATTACHMENT_ERROR_PREFIXES = [
  '发送前上传失败：',
  '暂不支持以下附件类型：',
  '暂不支持该附件类型：',
]
const BACKEND_ERROR_PREFIXES = [
  'receive model stream:',
  'decode model message:',
  'decode tool message:',
]
const WAITING_ERROR_FRAGMENTS = [
  'waiting for continuation',
  'session is waiting for interrupt approval',
]

const normalizeErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message.trim() : ''

const isAttachmentErrorMessage = (message: string) =>
  ATTACHMENT_ERROR_PREFIXES.some((prefix) => message.startsWith(prefix)) ||
  message.startsWith('附件 ') ||
  message.startsWith('当前环境无法') ||
  message.startsWith('当前环境不支持')

const isBackendErrorMessage = (message: string) =>
  BACKEND_ERROR_PREFIXES.some((prefix) => message.startsWith(prefix))
const isWaitingForContinuationMessage = (message: string) => {
  const normalizedMessage = message.toLowerCase()
  return WAITING_ERROR_FRAGMENTS.some((fragment) => normalizedMessage.includes(fragment))
}

export const classifyProjectChatError = (error: unknown): ClassifiedProjectChatError => {
  const message = normalizeErrorMessage(error)

  if (isAttachmentErrorMessage(message)) {
    return {
      kind: 'attachment',
      message,
    }
  }

  if (message === CHAT_INTERFACE_NOT_READY_MESSAGE) {
    return {
      kind: 'request',
      message,
    }
  }

  if (
    message === WAITING_FOR_CONTINUATION_REQUEST_ERROR_MESSAGE ||
    isWaitingForContinuationMessage(message)
  ) {
    return {
      kind: 'request',
      message: WAITING_FOR_CONTINUATION_REQUEST_ERROR_MESSAGE,
    }
  }

  if (isBackendErrorMessage(message)) {
    return {
      kind: 'backend',
      message: BACKEND_AGENT_RUNTIME_ERROR_MESSAGE,
    }
  }

  return {
    kind: 'request',
    message: message.length > 0 ? message : GENERIC_REQUEST_ERROR_MESSAGE,
  }
}
