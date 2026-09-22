import type { GenerationJob } from '@/features/storyboard/storyboard.api'

/** 一条生成记录的测试夹具：默认是一条已完成、没产物、不挂需求单的独立视频记录，按需覆盖。 */
export const makeGenerationJob = (overrides: Partial<GenerationJob> = {}): GenerationJob => ({
  id: crypto.randomUUID(),
  kind: 'video',
  status: 'completed',
  createdAt: '2026-09-16T10:00:00Z',
  errorMessage: null,
  metadata: null,
  outputUrl: null,
  request: {},
  taskId: null,
  rootJobId: null,
  clipStage: null,
  durationMs: null,
  watermarkOutputUrl: null,
  ...overrides,
})
