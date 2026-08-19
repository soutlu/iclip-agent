import { z } from 'zod'
import type {
  CreateProducerProjectInput,
  ProducerProjectCanvasLayout,
  ProducerProjectSession,
  ReplaceProducerProjectCanvasLayoutInput,
} from '@/features/projects/producer-project.types'
import { apiFetch } from '@/shared/api/client'
import { optionalStringSchema, requiredStringSchema } from '@/shared/api/schemas'
import { PRODUCER_AGUI_TARGET } from '@/shared/config/agui-target'

/** 后端 session 摘要 wire schema（时间字段容错归一为 null）。 */
export const producerProjectSessionSchema = z.object(
  {
    createdAt: optionalStringSchema,
    id: requiredStringSchema('Producer session 缺少 id'),
    projectId: requiredStringSchema('Producer session 缺少 projectId'),
    // target id 的事实源是后端运行目标注册表：wire 层只校验非空字符串。
    target: z
      .string({
        error: (issue) =>
          issue.input === undefined
            ? 'Producer session 缺少 target'
            : 'Producer session target 无效',
      })
      .refine((value) => value.trim().length > 0, 'Producer session target 无效'),
    title: requiredStringSchema('Producer session 缺少 title'),
    updatedAt: optionalStringSchema,
  },
  { error: 'Producer session 响应格式无效' },
)

/** 后端项目文件夹 wire schema。 */
export const producerProjectSchema = z.object(
  {
    createdAt: optionalStringSchema,
    id: requiredStringSchema('Producer project 缺少 id'),
    kind: z.enum(['agent', 'direct'], {
      error: (issue) =>
        issue.input === undefined ? 'Producer project 缺少 kind' : 'Producer project kind 无效',
    }),
    sessionIds: z.array(requiredStringSchema('Producer project 缺少 sessionIds'), {
      error: 'Producer project 缺少 sessionIds',
    }),
    title: requiredStringSchema('Producer project 缺少 title'),
    updatedAt: optionalStringSchema,
  },
  { error: 'Producer project 响应格式无效' },
)

const producerProjectsResponseSchema = z.object(
  { projects: z.array(producerProjectSchema, { error: 'Producer project 列表响应格式无效' }) },
  { error: 'Producer project 列表响应格式无效' },
)

const producerProjectResponseSchema = z.object(
  { project: producerProjectSchema },
  { error: 'Producer project 响应格式无效' },
)

const producerProjectSessionsResponseSchema = z.object(
  {
    sessions: z.array(producerProjectSessionSchema, { error: 'Producer session 列表响应格式无效' }),
  },
  { error: 'Producer session 列表响应格式无效' },
)

const producerProjectSessionResponseSchema = z.object(
  { session: producerProjectSessionSchema },
  { error: 'Producer session 响应格式无效' },
)

const producerProjectCanvasLayoutNodeSchema = z.strictObject({
  layoutMode: z.enum(['auto', 'manual']),
  nodeId: requiredStringSchema('Producer project canvas layout node 缺少 nodeId'),
  x: z.number().finite(),
  y: z.number().finite(),
})

const producerProjectCanvasLayoutNodesSchema = z
  .array(producerProjectCanvasLayoutNodeSchema)
  .superRefine((nodes, context) => {
    const seenNodeIds = new Set<string>()

    for (const [index, node] of nodes.entries()) {
      if (seenNodeIds.has(node.nodeId)) {
        context.addIssue({
          code: 'custom',
          message: 'Producer project canvas layout nodeId 重复',
          path: [index, 'nodeId'],
        })
        continue
      }

      seenNodeIds.add(node.nodeId)
    }
  })

const producerProjectCanvasLayoutSchema = z.strictObject({
  nodes: producerProjectCanvasLayoutNodesSchema,
  revision: z.number().int().nonnegative(),
  schemaVersion: z.literal(1),
  updatedAt: z.string().nullable(),
}) satisfies z.ZodType<ProducerProjectCanvasLayout>

const producerProjectCanvasLayoutResponseSchema = z.strictObject(
  {
    layout: producerProjectCanvasLayoutSchema,
  },
  { error: 'Producer project canvas layout 响应格式无效' },
)

/**
 * 读取当前登录用户的项目文件夹列表。
 *
 * @param options - 请求控制选项。
 * @param options.signal - 用于取消当前请求的 AbortSignal。
 * @returns 当前登录用户可访问的项目文件夹列表。
 */
export const listProducerProjects = async ({ signal }: { signal?: AbortSignal } = {}) =>
  (
    await apiFetch('/projects', producerProjectsResponseSchema, {
      cache: 'no-store',
      fallbackErrorMessage: '加载项目列表失败',
      signal,
    })
  ).projects

/**
 * 创建一个新的项目文件夹。
 *
 * @param input - 项目类型与标题。
 * @returns 后端创建后的项目文件夹。
 */
export const createProducerProject = async (input: CreateProducerProjectInput) =>
  (
    await apiFetch('/projects', producerProjectResponseSchema, {
      body: {
        kind: input.kind,
        title: input.title ?? '新项目',
      },
      fallbackErrorMessage: '创建项目失败',
      method: 'POST',
    })
  ).project

/**
 * 修改项目文件夹标题。
 *
 * @param projectId - 项目文件夹 id。
 * @param title - 需要保存的新项目标题。
 * @param options - 请求控制选项。
 * @param options.signal - 用于取消当前请求的 AbortSignal。
 * @returns 后端更新后的项目文件夹。
 */
export const renameProducerProject = async (
  projectId: string,
  title: string,
  { signal }: { signal?: AbortSignal } = {},
) =>
  (
    await apiFetch(`/projects/${encodeURIComponent(projectId)}`, producerProjectResponseSchema, {
      body: { title },
      cache: 'no-store',
      fallbackErrorMessage: '重命名项目失败',
      method: 'PATCH',
      signal,
    })
  ).project

/**
 * 读取单个项目文件夹。
 *
 * @param projectId - 项目文件夹 id。
 * @param options - 请求控制选项。
 * @param options.signal - 用于取消当前请求的 AbortSignal。
 * @returns 当前登录用户可访问的项目文件夹。
 */
export const getProducerProject = async (
  projectId: string,
  { signal }: { signal?: AbortSignal } = {},
) =>
  (
    await apiFetch(`/projects/${encodeURIComponent(projectId)}`, producerProjectResponseSchema, {
      cache: 'no-store',
      fallbackErrorMessage: '加载项目信息失败',
      signal,
    })
  ).project

/**
 * 读取项目画布布局快照。
 *
 * @param projectId - 项目文件夹 id。
 * @param options - 请求控制选项。
 * @param options.signal - 用于取消当前请求的 AbortSignal。
 * @returns 后端持有的布局快照；新项目返回 revision 0 的空布局。
 */
export const getProducerProjectCanvasLayout = async (
  projectId: string,
  { signal }: { signal?: AbortSignal } = {},
) =>
  (
    await apiFetch(
      `/projects/${encodeURIComponent(projectId)}/canvas-layout`,
      producerProjectCanvasLayoutResponseSchema,
      {
        cache: 'no-store',
        fallbackErrorMessage: '加载项目画布布局失败',
        signal,
      },
    )
  ).layout

/**
 * 以完整快照替换项目画布布局。
 *
 * @param projectId - 项目文件夹 id。
 * @param input - 当前 revision 与完整节点位置快照。
 * @param options - 请求控制选项。
 * @param options.signal - 用于取消当前请求的 AbortSignal。
 * @returns 保存后的布局及递增 revision。
 */
export const replaceProducerProjectCanvasLayout = async (
  projectId: string,
  input: ReplaceProducerProjectCanvasLayoutInput,
  { signal }: { signal?: AbortSignal } = {},
) =>
  (
    await apiFetch(
      `/projects/${encodeURIComponent(projectId)}/canvas-layout`,
      producerProjectCanvasLayoutResponseSchema,
      {
        body: input,
        cache: 'no-store',
        fallbackErrorMessage: '保存项目画布布局失败',
        method: 'PUT',
        signal,
      },
    )
  ).layout

/**
 * 创建项目文件夹下的新 session。
 *
 * @param projectId - 项目文件夹 id。
 * @param options - 请求控制选项。
 * @param options.signal - 用于取消当前请求的 AbortSignal。
 * @param options.target - session 绑定的运行目标 id，默认 Producer 团队。
 * @returns 新创建的 session。
 */
export const createProducerProjectSession = async (
  projectId: string,
  { signal, target = PRODUCER_AGUI_TARGET.id }: { signal?: AbortSignal; target?: string } = {},
) =>
  (
    await apiFetch(
      `/projects/${encodeURIComponent(projectId)}/sessions`,
      producerProjectSessionResponseSchema,
      {
        body: { target },
        cache: 'no-store',
        fallbackErrorMessage: '创建对话失败',
        method: 'POST',
        signal,
      },
    )
  ).session

/**
 * 读取项目文件夹下的 sessions。
 *
 * @param projectId - 项目文件夹 id。
 * @param options - 请求控制选项。
 * @param options.signal - 用于取消当前请求的 AbortSignal。
 * @returns 当前项目文件夹下的 session 列表。
 */
export const listProducerProjectSessions = async (
  projectId: string,
  { signal }: { signal?: AbortSignal } = {},
) => {
  const sessions = (
    await apiFetch(
      `/projects/${encodeURIComponent(projectId)}/sessions`,
      producerProjectSessionsResponseSchema,
      {
        cache: 'no-store',
        fallbackErrorMessage: '加载对话列表失败',
        signal,
      },
    )
  ).sessions

  return sessions.filter((session) => session.target === PRODUCER_AGUI_TARGET.id)
}

/**
 * 读取项目文件夹下的单个 session。
 *
 * @param projectId - 项目文件夹 id。
 * @param sessionId - Agno session id。
 * @param options - 请求控制选项。
 * @param options.signal - 用于取消当前请求的 AbortSignal。
 * @returns 当前项目文件夹下的 session 摘要。
 */
export const getProducerProjectSession = async (
  projectId: string,
  sessionId: string,
  { signal }: { signal?: AbortSignal } = {},
): Promise<ProducerProjectSession> => {
  const sessions = await listProducerProjectSessions(projectId, { signal })
  const session = sessions.find((item) => item.id === sessionId)

  if (!session) {
    throw new Error('对话不存在')
  }

  return session
}

/**
 * 删除项目文件夹下仍未命名的 session。
 *
 * @param sessionId - Agno session id。
 * @param options - 请求控制选项。
 * @param options.signal - 用于取消当前请求的 AbortSignal。
 */
export const deleteUnnamedProducerProjectSession = async (
  sessionId: string,
  { signal }: { signal?: AbortSignal } = {},
) => {
  await apiFetch(`/sessions/${encodeURIComponent(sessionId)}`, z.unknown(), {
    cache: 'no-store',
    fallbackErrorMessage: '删除对话失败',
    method: 'DELETE',
    signal,
  })
}

/**
 * 修改当前 session 的展示名称。
 *
 * @param sessionId - Agno session id。
 * @param title - 需要保存的新 session 名称。
 * @param options - 请求控制选项。
 * @param options.signal - 用于取消当前请求的 AbortSignal。
 */
export const renameProducerProjectSession = async (
  sessionId: string,
  title: string,
  { signal }: { signal?: AbortSignal } = {},
) => {
  await apiFetch(`/sessions/${encodeURIComponent(sessionId)}/rename`, z.unknown(), {
    body: { session_name: title },
    cache: 'no-store',
    fallbackErrorMessage: '重命名对话失败',
    method: 'POST',
    signal,
  })
}
