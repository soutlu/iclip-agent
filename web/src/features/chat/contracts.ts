export interface ProjectMessageMetadata {
  createdAt?: number | string
}

export interface AskUserQuestionOption {
  description?: string
  label: string
  preview?: string
}

export interface AskUserQuestionItem {
  header: string
  multiSelect?: boolean
  options: AskUserQuestionOption[]
  question: string
  required?: boolean
}

export interface AskUserQuestionToolAnswer {
  otherText?: string
  values: string[]
}

export interface AskUserQuestionToolInput {
  annotations?: Record<string, string>
  answers?: Record<string, AskUserQuestionToolAnswer>
  metadata?: {
    source?: string
  }
  questions: AskUserQuestionItem[]
}

export interface AskUserQuestionToolOutput {
  answers: Record<string, AskUserQuestionToolAnswer>
}

interface ProjectMessagePartBase {
  id?: string
  providerMetadata?: Record<string, unknown>
}

export interface ProjectTextPart extends ProjectMessagePartBase {
  text: string
  type: 'text'
}

export interface ProjectReasoningPart extends ProjectMessagePartBase {
  text: string
  type: 'reasoning'
}

export interface ProjectStepStartPart extends ProjectMessagePartBase {
  type: 'step-start'
}

export interface ProjectFilePart extends ProjectMessagePartBase {
  filename?: string
  mediaType: string
  type: 'file'
  url: string
}

export interface ProjectSourceUrlPart extends ProjectMessagePartBase {
  sourceId: string
  title?: string
  type: 'source-url'
  url: string
}

export interface ProjectSourceDocumentPart extends ProjectMessagePartBase {
  filename?: string
  mediaType: string
  sourceId: string
  title: string
  type: 'source-document'
}

interface ProjectToolPartBase<
  TType extends string,
  TInput = unknown,
  TOutput = unknown,
> extends ProjectMessagePartBase {
  callProviderMetadata?: Record<string, unknown>
  dynamic?: boolean
  errorText?: string
  input?: TInput
  output?: TOutput
  preliminary?: boolean
  providerExecuted?: boolean
  rawInput?: unknown
  state?: string
  title?: string
  toolCallId: string
  type: TType
}

export type ProjectGenericToolPart = ProjectToolPartBase<`tool-${string}`>

export interface ProjectDynamicToolPart extends ProjectToolPartBase<'dynamic-tool'> {
  toolName: string
}

export type ProjectMessagePart =
  | ProjectDynamicToolPart
  | ProjectFilePart
  | ProjectGenericToolPart
  | ProjectReasoningPart
  | ProjectSourceDocumentPart
  | ProjectSourceUrlPart
  | ProjectStepStartPart
  | ProjectTextPart

export interface ProjectUIMessage {
  id: string
  metadata?: ProjectMessageMetadata
  parts: ProjectMessagePart[]
  role: 'assistant' | 'system' | 'user'
}

export type ProjectToolLogStage = 'completed' | 'failed' | 'started'

export type ProjectToolLogActorLabel = '主agent' | '子agent'

export interface ProjectToolLogEntry {
  actorLabel: ProjectToolLogActorLabel
  dedupeKey: string
  id: string
  message: string
  rawToolName: string
  stage: ProjectToolLogStage
  targetLabel?: string
  timestamp: number
  toolCallId: string
  toolName: string
}

export interface ProjectUserMessageTimelineItem {
  id: string
  kind: 'user-message'
  message: ProjectUIMessage
}

export type ProjectAssistantBubbleAgentKind = 'creative-director' | 'producer' | 'storyboard'

export interface ProjectAssistantBubbleTimelineItem {
  agentKind: ProjectAssistantBubbleAgentKind
  id: string
  isResponseShell?: boolean
  kind: 'assistant-bubble'
  message: ProjectUIMessage
}

export interface ProjectTimelineToolState {
  rawToolName: string
  state?: string
  toolCallId: string
}

export interface ProjectToolLogSegmentTimelineItem {
  id: string
  kind: 'tool-log-segment'
  logs: ProjectToolLogEntry[]
  toolStates: ProjectTimelineToolState[]
}

export interface ProjectAskUserQuestionTimelineItem {
  id: string
  kind: 'ask-user-question'
  request: AskUserQuestionToolInput
  response?: AskUserQuestionToolOutput
  toolCallId: string
}

export type ProjectSubagentFlowEventStatus = 'completed' | 'failed' | 'started'

export interface ProjectSubagentFlowEvent {
  id: string
  label: string
  status: ProjectSubagentFlowEventStatus
}

export type ProjectMemberSegmentPart =
  ProjectGenericToolPart | ProjectReasoningPart | ProjectTextPart

export interface ProjectMemberSegment {
  memberId: string
  memberRunId: string
  parentToolCallId: string | null
  parts: ProjectMemberSegmentPart[]
}

export interface ProjectSubagentFlowTimelineItem {
  events: ProjectSubagentFlowEvent[]
  id: string
  kind: 'subagent-flow'
  segments?: ProjectMemberSegment[]
  targetLabel: string
  toolCallId: string
}

export type ProjectChatTimelineItem =
  | ProjectAskUserQuestionTimelineItem
  | ProjectAssistantBubbleTimelineItem
  | ProjectSubagentFlowTimelineItem
  | ProjectToolLogSegmentTimelineItem
  | ProjectUserMessageTimelineItem

export interface ProjectAskUserQuestionInterrupt {
  createdAt: string
  interruptId: string
  kind: 'ask_user_question'
  request: AskUserQuestionToolInput
  targetId: string
}

export interface ProjectToolApprovalInterrupt {
  createdAt: string
  interruptId: string
  kind: 'tool_approval'
  request: {
    sourceToolCallId: string
    sourceToolName: string
    toolArgs?: unknown
  }
  targetId: string
  toolName: string
}

export type ProjectChatInterrupt = ProjectAskUserQuestionInterrupt | ProjectToolApprovalInterrupt
