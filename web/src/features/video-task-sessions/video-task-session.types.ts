import type { ProducerProjectSession } from '@/features/projects'

export type VideoTaskSession = {
  createdAt: string
  session: ProducerProjectSession
  videoTaskId: string
}

export type CreateVideoTaskSessionInput = {
  projectId: string
  videoTaskId: string
}
