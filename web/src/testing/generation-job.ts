import type { GenerationJob } from '@/features/storyboard/storyboard.api'

/** 一条生成记录的测试夹具：默认是一条已完成、没产物、不挂需求单的出片（无来源），按需覆盖。 */
export const makeGenerationJob = (overrides: Partial<GenerationJob> = {}): GenerationJob => ({
  id: crypto.randomUUID(),
  kind: 'video',
  operation: 'generate',
  status: 'completed',
  createdAt: '2026-09-16T10:00:00Z',
  finishedAt: null,
  errorMessage: null,
  metadata: null,
  outputUrl: null,
  request: {},
  taskId: null,
  shotIndex: null,
  rootJobId: null,
  sourceJobId: null,
  rangeStartMs: null,
  rangeEndMs: null,
  clipStage: null,
  durationMs: null,
  watermarkOutputUrl: null,
  ...overrides,
})
