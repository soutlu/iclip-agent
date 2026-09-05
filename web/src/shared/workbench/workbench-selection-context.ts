/** 在 shared 层连接工作台与聊天 feature 的选中引用，发送时转换为正文前缀（ADR-0009 决策 6）。 */

import { createContext } from 'react'

/** id 标识引用，label 用于芯片，prefix 拼接到消息正文前。 */
export interface WorkbenchRef {
  id: string
  label: string
  prefix: string
}

export interface WorkbenchSelection {
  refs: readonly WorkbenchRef[]
  /** focus 表示用户显式选择：恢复已移除芯片并请求聚焦；自动同步不携带此标记。 */
  set: (refs: readonly WorkbenchRef[], options?: { focus?: boolean }) => void
  clear: () => void
  remove: (id: string) => void
  /** focusToken 递增只用于通知聚焦，消费方不依赖其具体值。 */
  focusToken: number
}

export const WorkbenchSelectionContext = createContext<WorkbenchSelection | null>(null)
