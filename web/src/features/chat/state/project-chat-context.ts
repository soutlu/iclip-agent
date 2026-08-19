import { createContext, useContext } from 'react'
import type { ProjectArtifactDescriptor } from '@/features/artifacts'
import type {
  AskUserQuestionToolOutput,
  ProjectChatInterrupt,
  ProjectChatTimelineItem,
} from '@/features/chat/contracts'
import type { AgentOSSessionStatus } from '@/features/chat/api/agentos-runs'
import type { ProducerProjectMediaItem } from '@/features/chat/project-state.types'
import type { ProducerVideoGenerationSubmission } from '@/features/projects'
import type { MediaComposerDraft } from '@/shared/composer'

export interface AgentVideoPromptGenerationInput {
  aspectRatio: string
  prompt: string
  referenceAudios: string[]
  referenceImages: string[]
  referenceVideos: string[]
  seconds: number
  shotIndex: number
}

export interface AgentVideoPromptSaveInput {
  prompt: string
  shotIndex: number
}

export interface ProjectChatActivityContextValue {
  isInteractionLocked: boolean
  sessionRunStatus: AgentOSSessionStatus | null
}

export interface ProjectChatResourcesContextValue {
  artifacts: ProjectArtifactDescriptor[]
  assets: Record<string, unknown>[]
  generationRecords: Record<string, unknown>[]
  projectMedia: ProducerProjectMediaItem[]
}

export interface ProjectChatVideoGenerationContextValue {
  isInteractionLocked: boolean
  saveVideoPrompt: (input: AgentVideoPromptSaveInput) => Promise<void>
  submitVideoGenerations: (
    inputs: AgentVideoPromptGenerationInput[],
  ) => Promise<ProducerVideoGenerationSubmission[]>
  submitVideoGeneration: (
    input: AgentVideoPromptGenerationInput,
  ) => Promise<ProducerVideoGenerationSubmission>
}

export interface ProjectChatAskUserQuestionContextValue {
  isInteractionLocked: boolean
  submitAskUserQuestionOutput: (
    targetId: string,
    output: AskUserQuestionToolOutput,
  ) => Promise<void>
}

export interface ProjectChatComposerContextValue {
  activeInterrupt: ProjectChatInterrupt | null
  isInteractionLocked: boolean
  projectMedia: ProducerProjectMediaItem[]
  submitDraft: (draft: MediaComposerDraft) => Promise<void>
}

export interface ProjectChatConversationContextValue {
  activeInterrupt: ProjectChatInterrupt | null
  projectMedia: ProducerProjectMediaItem[]
  timelineItems: ProjectChatTimelineItem[]
}

export const ProjectChatActivityContext = createContext<ProjectChatActivityContextValue | null>(
  null,
)
export const ProjectChatActiveInterruptContext = createContext<
  ProjectChatInterrupt | null | undefined
>(undefined)
export const ProjectChatAskUserQuestionContext =
  createContext<ProjectChatAskUserQuestionContextValue | null>(null)
export const ProjectChatComposerContext = createContext<ProjectChatComposerContextValue | null>(
  null,
)
export const ProjectChatConversationContext =
  createContext<ProjectChatConversationContextValue | null>(null)
export const ProjectChatResourcesContext = createContext<ProjectChatResourcesContextValue | null>(
  null,
)
export const ProjectChatTitleContext = createContext<string | null>(null)
export const ProjectChatVideoGenerationContext =
  createContext<ProjectChatVideoGenerationContextValue | null>(null)

export const useProjectChatActivity = () => {
  const context = useContext(ProjectChatActivityContext)

  if (!context) {
    throw new Error('useProjectChatActivity 必须在 ProjectChatProvider 内使用。')
  }

  return context
}

export const useProjectChatTitle = () => {
  const title = useContext(ProjectChatTitleContext)

  if (title === null) {
    throw new Error('useProjectChatTitle 必须在 ProjectChatProvider 内使用。')
  }

  return title
}

export const useProjectChatActiveInterrupt = () => {
  const activeInterrupt = useContext(ProjectChatActiveInterruptContext)

  if (activeInterrupt === undefined) {
    throw new Error('useProjectChatActiveInterrupt 必须在 ProjectChatProvider 内使用。')
  }

  return activeInterrupt
}

export const useProjectChatResources = () => {
  const context = useContext(ProjectChatResourcesContext)

  if (!context) {
    throw new Error('useProjectChatResources 必须在 ProjectChatProvider 内使用。')
  }

  return context
}

export const useProjectChatVideoGeneration = () => {
  const context = useContext(ProjectChatVideoGenerationContext)

  if (!context) {
    throw new Error('useProjectChatVideoGeneration 必须在 ProjectChatProvider 内使用。')
  }

  return context
}

export const useProjectChatAskUserQuestion = () => {
  const context = useContext(ProjectChatAskUserQuestionContext)

  if (!context) {
    throw new Error('useProjectChatAskUserQuestion 必须在 ProjectChatProvider 内使用。')
  }

  return context
}

export const useProjectChatComposer = () => {
  const context = useContext(ProjectChatComposerContext)

  if (!context) {
    throw new Error('useProjectChatComposer 必须在 ProjectChatProvider 内使用。')
  }

  return context
}

export const useProjectChatConversation = () => {
  const context = useContext(ProjectChatConversationContext)

  if (!context) {
    throw new Error('useProjectChatConversation 必须在 ProjectChatProvider 内使用。')
  }

  return context
}
