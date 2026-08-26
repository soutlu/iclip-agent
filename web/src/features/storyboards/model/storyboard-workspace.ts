import type { VideoTaskOverview } from '@/features/tasks'

/** 创作 Brief 生命周期：待确认 / 已确认待提交 / 已提交。 */
export type StoryboardStatus = 'confirmed' | 'draft' | 'submitted'

/** 单个镜头版本。 */
export type StoryboardVersion = {
  createdAt: string
  id: string
  instruction: string
  label: string
}

/** 单个故事板镜头。 */
export type StoryboardShot = {
  aspectRatio: '16:9' | '21:9' | '4:3' | '9:16'
  cameraMovement: string
  description: string
  dialogue: string
  draftState?: 'blank'
  durationSeconds: number
  id: string
  previewUrl: null | string
  sequence: number
  shotSize: string
  title: string
  versions: StoryboardVersion[]
}

/** Storyboard Agent 单次执行前接收的结构化创作信息。 */
export type StoryboardCreativeOverview = VideoTaskOverview

export type StoryboardCreativeInput = StoryboardCreativeOverview & {
  category?: string
  /** 成片目标时长（秒），来自 Task Brief 的 durationSeconds。 */
  durationSeconds?: number
  knownConstraints?: string
  /** 目标画幅，来自 Task Brief 的 ratio（如 16:9 / 9:16 / 3:4 / 1:1）。 */
  ratio?: string
  referenceImages: StoryboardInputImage[]
  referenceVideos: StoryboardInputVideo[]
  /** 需求描述（含按跨仓约定追加的口播旁白），按段落换行的纯文本。 */
  requirementDescription?: string
  styleNo?: string
}

/** 创作 Brief 中的一张输入参考图。 */
export type StoryboardInputImage = {
  aspectRatio: StoryboardShot['aspectRatio']
  id: string
  mimeType: string
  previewUrl: string
  title: string
}

/** 创作 Brief 中的一条输入参考视频。 */
export type StoryboardInputVideo = StoryboardInputImage & {
  duration?: string
}

/** 同一张需求单的一次尝试：一段对话，加它到目前为止形成的 Storyboard。 */
export type Storyboard = {
  aspectRatioPlan?: string
  confirmedAt: null | string
  /** 这次尝试的对话 id，同时是 AG-UI 的 threadId。 */
  conversationId: string
  creativeInput: StoryboardCreativeInput
  durationPlan?: string
  kindLabel?: string
  modelDescription?: string
  modelLabel: string
  shots: StoryboardShot[]
  status: StoryboardStatus
  styleDescription?: string
  subtitle?: string
  title: string
  videoTaskId: string
}

/** Storyboard 页面渲染所需的工作台数据：一张需求单的历次尝试，按开始时间正序。 */
export type StoryboardWorkspace = {
  storyboards: Storyboard[]
}
