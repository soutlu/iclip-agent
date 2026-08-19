export type GeneratedVideoStatus =
  'cancelled' | 'failed' | 'processing' | 'queued' | 'running' | 'succeeded'

export interface GeneratedVideoItem {
  attempt?: number
  createdAt?: string
  error?: string
  generationId: string
  outputUrl?: string
  promptIndex?: number
  status: GeneratedVideoStatus
  taskId?: string
}

export interface GeneratedVideoOutput {
  videos: GeneratedVideoItem[]
}
