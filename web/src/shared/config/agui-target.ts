import { env } from '@/shared/config/env'

const AGUI_NAMESPACE = 'agui'

const AGUI_TARGET_COLLECTIONS = new Set(['agents', 'teams'])

/**
 * 规范化 AG-UI target path，补齐开头斜杠并移除多余末尾斜杠。
 *
 * @param path - 环境变量提供的 target path。
 * @returns 以单个开头斜杠表示的规范化路径。
 */
const normalizeTargetPath = (path: string) => {
  const trimmedPath = path.trim()
  const pathWithLeadingSlash = trimmedPath.startsWith('/') ? trimmedPath : `/${trimmedPath}`
  const pathWithoutTrailingSlashes = pathWithLeadingSlash.replace(/\/+$/, '')

  return pathWithoutTrailingSlashes.length > 0 ? pathWithoutTrailingSlashes : '/'
}

/**
 * 校验并返回 AG-UI target 的路径与注册 id。
 *
 * @returns 当前 AG-UI target 的规范化路径与 id。
 * @throws 当 VITE_AGUI_TARGET_PATH 不符合约定时抛出错误。
 */
const resolveAguiTarget = () => {
  const path = normalizeTargetPath(env.VITE_AGUI_TARGET_PATH)
  const pathSegments = path.split('/').filter(Boolean)
  const [namespace, collection, id] = pathSegments

  if (
    pathSegments.length !== 3 ||
    namespace !== AGUI_NAMESPACE ||
    !collection ||
    !AGUI_TARGET_COLLECTIONS.has(collection) ||
    !id
  ) {
    throw new Error(
      `Invalid VITE_AGUI_TARGET_PATH: expected /agui/agents/<id> or /agui/teams/<id>, received "${path}".`,
    )
  }

  return { id, path }
}

const AGUI_TARGET = resolveAguiTarget()

/** Producer 项目聊天使用的 AG-UI 注册目标。 */
export const PRODUCER_AGUI_TARGET = {
  apiPrefix: `/api${AGUI_TARGET.path}`,
  id: AGUI_TARGET.id,
  path: AGUI_TARGET.path,
} as const

/**
 * Storyboard agent：后端 `agents.yaml` 里声明的 id，同时是运行端点 URL 里的那一段。
 *
 * `runUrl` 是完整的同源 SSE 端点（`POST /agents/{agentId}/chat`），交给 `@ag-ui/client`
 * 的 `HttpAgent`；开对话用 `id`（`POST /conversations` 的 `agentId`）。
 */
export const STORYBOARD_AGENT = {
  id: 'storyboard',
  runUrl: '/api/agents/storyboard/chat',
} as const
