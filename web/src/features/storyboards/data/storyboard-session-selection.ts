const STORYBOARD_SESSION_SELECTION_PREFIX = 'producer.storyboard.activeSession'

/**
 * 生成 Storyboard 项目 active session 的浏览器会话存储 key。
 *
 * @param projectId - Storyboard project id。
 * @returns 当前项目对应的 sessionStorage key。
 */
const createStoryboardSessionSelectionKey = (projectId: string) =>
  `${STORYBOARD_SESSION_SELECTION_PREFIX}.${projectId}`

/**
 * 读取当前浏览器会话中记录的 Storyboard active session。
 *
 * @param projectId - Storyboard project id。
 * @returns 已记录的 Agno session id；缺失时返回 null。
 */
export const readPreferredStoryboardSessionId = (projectId: string) => {
  if (typeof window === 'undefined') {
    return null
  }

  const sessionId = window.sessionStorage.getItem(createStoryboardSessionSelectionKey(projectId))
  return sessionId?.trim() || null
}

/**
 * 记录当前 Storyboard 项目最近选中的 session。
 *
 * @param projectId - Storyboard project id。
 * @param sessionId - Agno session id。
 * @returns 无返回值。
 */
export const storePreferredStoryboardSessionId = (projectId: string, sessionId: string) => {
  if (typeof window === 'undefined') {
    return
  }

  window.sessionStorage.setItem(createStoryboardSessionSelectionKey(projectId), sessionId)
}
