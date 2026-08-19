import type { ProjectUIMessage } from '@/features/chat/contracts'
import { DEFAULT_PRODUCER_PROJECT_SESSION_TITLE } from '@/features/projects'

export const DEFAULT_PROJECT_TITLE = DEFAULT_PRODUCER_PROJECT_SESSION_TITLE

/**
 * 抽取项目 UI 消息中的纯文本内容。
 *
 * @param message - 需要读取文本的项目 UI 消息。
 * @returns 按消息 part 顺序拼接后的文本。
 */
export const extractMessageText = (message: ProjectUIMessage) =>
  message.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
