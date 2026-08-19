export const DEFAULT_PRODUCER_PROJECT_SESSION_TITLE = '新对话'

/**
 * 规范化 Producer 项目 session 展示标题。
 *
 * @param title - 后端或调用方提供的 session 标题。
 * @returns 可展示的 session 标题；空值回落到默认未命名标题。
 */
export const normalizeProducerProjectSessionTitle = (title: null | string | undefined) =>
  title?.trim() || DEFAULT_PRODUCER_PROJECT_SESSION_TITLE

/**
 * 判断 session 是否仍处于默认未命名状态。
 *
 * @param title - 后端返回的 session 展示标题。
 * @returns 标题为空或仍是默认标题时返回 true。
 */
export const isUnnamedProducerProjectSessionTitle = (title: string) =>
  normalizeProducerProjectSessionTitle(title) === DEFAULT_PRODUCER_PROJECT_SESSION_TITLE
