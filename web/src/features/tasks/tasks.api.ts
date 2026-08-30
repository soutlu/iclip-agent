import { useQuery } from '@tanstack/react-query'
import type { z } from 'zod'
import { apiFetch } from '@/shared/api/client'
import type { zTaskCreateIn, zTaskIn } from '@/shared/api/generated/zod.gen'
import { zTaskEnvelope, zTasksPageOut } from '@/shared/api/generated/zod.gen'

export type Task = z.output<typeof zTaskEnvelope>['task']
export type TaskIn = z.input<typeof zTaskIn>
export type TaskCreateIn = z.input<typeof zTaskCreateIn>

const taskEnvelopeSchema = zTaskEnvelope.transform((payload) => payload.task)
const tasksPageSchema = zTasksPageOut.transform((payload) => payload.items)

export const tasksQueryKeys = {
  all: ['tasks'] as const,
  list: (scope: 'all' | 'mine') => ['tasks', 'list', scope] as const,
  detail: (taskId: string) => ['tasks', 'detail', taskId] as const,
}

/** 全部需求单，按最近改动倒序。 */
export const listAllTasks = async (): Promise<Task[]> =>
  apiFetch('/tasks?limit=100', tasksPageSchema, {
    cache: 'no-store',
    fallbackErrorMessage: '读取需求单列表失败',
  })

/** 「我的需求单」：我认领过的那些。认领人由服务端从会话身份取，前端不传 id。 */
export const listMyTasks = async (): Promise<Task[]> =>
  apiFetch('/tasks?claimedBy=me&limit=100', tasksPageSchema, {
    cache: 'no-store',
    fallbackErrorMessage: '读取我的需求单失败',
  })

/**
 * 需求单的下拉候选：只要 id 与标题。
 *
 * 与需求单页共用一个查询键，翻到侧栏再打开归属弹窗时不会再发一次请求。
 *
 * @param enabled - 用不到时不发请求（弹窗没打开、或者没登录）。
 * @returns TanStack query，数据是 `{ id, label }` 列表。
 */
export const useTaskOptions = (enabled: boolean) =>
  useQuery({
    enabled,
    queryFn: listAllTasks,
    queryKey: tasksQueryKeys.list('all'),
    select: (tasks) => tasks.map((task) => ({ id: task.id, label: task.title })),
  })

export const getTask = async (taskId: string): Promise<Task> =>
  apiFetch(`/tasks/${taskId}`, taskEnvelopeSchema, {
    cache: 'no-store',
    fallbackErrorMessage: '读取需求单失败',
  })

export const createTask = async (body: TaskCreateIn): Promise<Task> =>
  apiFetch('/tasks', taskEnvelopeSchema, {
    body,
    fallbackErrorMessage: '新建需求单失败',
    method: 'POST',
  })

/** 整体覆盖：body 必须是完整的一张单（先 get 再合并改动）。 */
export const saveTask = async (taskId: string, body: TaskIn): Promise<Task> =>
  apiFetch(`/tasks/${taskId}`, taskEnvelopeSchema, {
    body,
    fallbackErrorMessage: '保存需求单失败',
    method: 'PUT',
  })

export const publishTask = async (taskId: string): Promise<Task> =>
  apiFetch(`/tasks/${taskId}/publish`, taskEnvelopeSchema, {
    fallbackErrorMessage: '发布失败',
    method: 'POST',
  })

export const claimTask = async (taskId: string): Promise<Task> =>
  apiFetch(`/tasks/${taskId}/confirm`, taskEnvelopeSchema, {
    fallbackErrorMessage: '认领失败',
    method: 'POST',
  })

export const withdrawTask = async (taskId: string): Promise<Task> =>
  apiFetch(`/tasks/${taskId}/withdraw`, taskEnvelopeSchema, {
    fallbackErrorMessage: '撤回失败',
    method: 'POST',
  })
