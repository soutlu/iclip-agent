const STORYBOARD_CONVERSATION_SELECTION_PREFIX = 'producer.storyboard.activeConversation'

/**
 * 生成「这张需求单上次看的是哪一次尝试」的浏览器存储 key。
 *
 * @param taskId - 需求单 id。
 * @returns 这张单对应的 sessionStorage key。
 */
const createStoryboardConversationSelectionKey = (taskId: string) =>
  `${STORYBOARD_CONVERSATION_SELECTION_PREFIX}.${taskId}`

/**
 * 读取当前浏览器会话里记的、这张单上次选中的那次尝试。
 *
 * @param taskId - 需求单 id。
 * @returns 已记录的对话 id；没记过返回 null。
 */
export const readPreferredStoryboardConversationId = (taskId: string) => {
  if (typeof window === 'undefined') {
    return null
  }

  const conversationId = window.sessionStorage.getItem(
    createStoryboardConversationSelectionKey(taskId),
  )
  return conversationId?.trim() || null
}

/**
 * 记下这张单最近选中的那次尝试。
 *
 * @param taskId - 需求单 id。
 * @param conversationId - 这次尝试的对话 id。
 * @returns 无返回值。
 */
export const storePreferredStoryboardConversationId = (taskId: string, conversationId: string) => {
  if (typeof window === 'undefined') {
    return
  }

  window.sessionStorage.setItem(createStoryboardConversationSelectionKey(taskId), conversationId)
}
