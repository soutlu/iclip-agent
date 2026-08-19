const PROJECT_SESSION_SELECTION_PREFIX = 'producer.project.activeSession'

/**
 * 生成项目 active session 的浏览器会话存储 key。
 *
 * @param projectId - 项目文件夹 id。
 * @returns 当前项目对应的 sessionStorage key。
 */
const createProjectSessionSelectionKey = (projectId: string) =>
  `${PROJECT_SESSION_SELECTION_PREFIX}.${projectId}`

/**
 * 读取当前浏览器会话中记录的项目 active session。
 *
 * @param projectId - 项目文件夹 id。
 * @returns 已记录的 Agno session id；缺失时返回 null。
 */
export const readPreferredProducerProjectSessionId = (projectId: string) => {
  if (typeof window === 'undefined') {
    return null
  }

  const sessionId = window.sessionStorage.getItem(createProjectSessionSelectionKey(projectId))
  return sessionId?.trim() || null
}

/**
 * 记录当前项目最近打开的 session。
 *
 * @param projectId - 项目文件夹 id。
 * @param sessionId - Agno session id。
 * @returns 无返回值。
 */
export const storePreferredProducerProjectSessionId = (projectId: string, sessionId: string) => {
  if (typeof window === 'undefined') {
    return
  }

  window.sessionStorage.setItem(createProjectSessionSelectionKey(projectId), sessionId)
}
