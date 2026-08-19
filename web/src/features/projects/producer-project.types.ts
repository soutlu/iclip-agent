export type ProducerProjectKind = 'agent' | 'direct'

// target id 的事实源是后端运行目标注册表（config.yaml agent_os 段）：前端不枚举取值，
// wire 层只校验非空字符串，未注册 target 由后端在创建 session 时拒绝。
export type ProducerProjectTarget = string

export type CreateProducerProjectInput = {
  kind: ProducerProjectKind
  title?: string
}

export interface ProducerProjectCanvasLayoutNode {
  layoutMode: 'auto' | 'manual'
  nodeId: string
  x: number
  y: number
}

export interface ProducerProjectCanvasLayout {
  nodes: ProducerProjectCanvasLayoutNode[]
  revision: number
  schemaVersion: 1
  updatedAt: string | null
}

export interface ReplaceProducerProjectCanvasLayoutInput {
  expectedRevision: number
  nodes: ProducerProjectCanvasLayoutNode[]
  schemaVersion: 1
}

export type ProducerProjectSession = {
  createdAt: null | string
  id: string
  projectId: string
  target: ProducerProjectTarget
  title: string
  updatedAt: null | string
}

export type ProducerProject = {
  createdAt: null | string
  id: string
  kind: ProducerProjectKind
  sessionIds: string[]
  title: string
  updatedAt: null | string
}

export type ProducerProjectsResponse = {
  projects: ProducerProject[]
}

export type ProducerProjectResponse = {
  project: ProducerProject
}

export type ProducerProjectSessionResponse = {
  session: ProducerProjectSession
}

export type ProducerProjectSessionsResponse = {
  sessions: ProducerProjectSession[]
}

export type ProducerSessionWorkspaceDocument = {
  content: string
  etag: string
  path: string
}

export type ProducerSessionWorkspaceFileUpdate = {
  etag: string
  path: string
}

export type ProducerAssetRecord = Record<string, unknown>

export type ProducerAssetsResponse = {
  assets: ProducerAssetRecord[]
}

export type ProducerGenerationRecord = Record<string, unknown>

export type ProducerGenerationsResponse = {
  generations: ProducerGenerationRecord[]
}

export type ReplaceProducerSessionWorkspaceFileInput = {
  content: string
  etag: string
}

export type SubmitVideoGenerationRequestInput = {
  aspectRatio: string
  model: string
  prompt: string
  referenceAudios: string[]
  referenceImages: string[]
  referenceVideos: string[]
  seconds: number
  shotIndex: number
}

export type ProducerGenerationInputRef = {
  artifactId?: string
  assetId?: string
  kind: 'artifact' | 'asset' | 'text' | 'url'
  label?: string
  mediaType?: 'audio' | 'file' | 'image' | 'video'
  text?: string
  url?: string
}

export type ProducerGenerationRequestPayload = {
  inputs?: ProducerGenerationInputRef[]
  model?: string
  params?: Record<string, unknown>
  prompt?: string
  type: string
}

export type ProducerVideoGenerationTaskStatus = 'failed' | 'queued' | 'running' | 'succeeded'

export type ProducerVideoGenerationSubmission = {
  generation: {
    assetType: string
    completedAt: null | number | string
    createdAt: null | number | string
    errorCode: null | string
    errorMessage: null | string
    failedAt: null | number | string
    id: string
    providerSnapshot: null | Record<string, unknown>
    providerStatus: null | string
    providerTaskId: null | string
    rawStatus: string
    requestPayload: ProducerGenerationRequestPayload
    status: ProducerVideoGenerationTaskStatus
    submittedAt: null | number | string
    updatedAt: null | number | string
  }
}
