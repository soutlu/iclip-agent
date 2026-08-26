import { z } from 'zod'
import { producerProjectSessionSchema } from '@/features/projects'
import type {
  CreateVideoTaskSessionInput,
  VideoTaskSession,
} from '@/features/video-task-sessions/video-task-session.types'
import { apiFetch } from '@/shared/api/client'
import { requiredStringSchema } from '@/shared/api/schemas'
import { STORYBOARD_AGENT } from '@/shared/config/agui-target'

const videoTaskSessionSchema = z.strictObject({
  createdAt: requiredStringSchema('VideoTaskSession 缺少 createdAt'),
  session: producerProjectSessionSchema,
  videoTaskId: requiredStringSchema('VideoTaskSession 缺少 videoTaskId'),
}) satisfies z.ZodType<VideoTaskSession>

const videoTaskSessionResponseSchema = z.strictObject({
  videoTaskSession: videoTaskSessionSchema,
})

const videoTaskSessionsResponseSchema = z.strictObject({
  videoTaskSessions: z.array(videoTaskSessionSchema),
})

/** 为 Video Task 创建一个独立 Project Session，并返回显式关系。 */
export const createVideoTaskSession = async (
  input: CreateVideoTaskSessionInput,
  { signal }: { signal?: AbortSignal } = {},
) =>
  (
    await apiFetch('/video-task-sessions', videoTaskSessionResponseSchema, {
      body: {
        ...input,
        target: STORYBOARD_AGENT.id,
      },
      cache: 'no-store',
      fallbackErrorMessage: '创建 Storyboard Session 失败',
      method: 'POST',
      signal,
    })
  ).videoTaskSession

/** 读取 Project 中全部显式 VideoTaskSession 关系。 */
export const listVideoTaskSessions = async (
  projectId: string,
  { signal }: { signal?: AbortSignal } = {},
) =>
  (
    await apiFetch(
      `/video-task-sessions?projectId=${encodeURIComponent(projectId)}`,
      videoTaskSessionsResponseSchema,
      {
        cache: 'no-store',
        fallbackErrorMessage: '加载 Storyboard Sessions 失败',
        signal,
      },
    )
  ).videoTaskSessions
