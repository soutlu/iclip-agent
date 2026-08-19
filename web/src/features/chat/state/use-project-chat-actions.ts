import {
  type AgUiResumeEntry,
  useAgUiInterrupts,
  useAgUiSubmitInterruptResponses,
} from '@assistant-ui/react-ag-ui'
import type { Dispatch, RefObject, SetStateAction } from 'react'
import { useCallback } from 'react'
import type {
  AskUserQuestionToolInput,
  AskUserQuestionToolOutput,
  ProjectChatInterrupt,
} from '@/features/chat/contracts'
import {
  type ProducerVideoGenerationSubmission,
  producerGenerationRecordFromSubmission,
  readProducerSessionWorkspaceFile,
  replaceProducerSessionWorkspaceFile,
  submitSessionVideoGeneration,
} from '@/features/projects'
import { DEFAULT_VIDEO_GENERATION_MODEL } from '@/shared/composer/VideoGenerationSettingsControl'
import { isRecord } from '@/shared/lib/guards'
import { WAITING_FOR_CONTINUATION_REQUEST_ERROR_MESSAGE } from '../lib/project-chat-error'
import { isAskUserQuestionToolOutput } from '../runtime/project-agui-runtime'
import type {
  AgentVideoPromptGenerationInput,
  AgentVideoPromptSaveInput,
} from './project-chat-context'
import {
  buildAskUserQuestionValuesPayload,
  replaceVideoShotPrompt,
  VIDEO_SHOT_PATH,
} from './project-chat-provider.utils'

interface ProjectInterruptActionsParams {
  applyClassifiedError: (params: { error: unknown }) => void
  clearProjectErrorMessages: () => void
  pendingInterruptResponses: Record<string, AgUiResumeEntry>
  setPendingInterruptResponses: Dispatch<SetStateAction<Record<string, AgUiResumeEntry>>>
}

/**
 * 提供中断响应与 ask_user_question 提交动作。
 *
 * 从 ProjectChatBusinessProvider 中拆出的动作簇：行为与依赖保持原样，
 * 仅通过参数显式接收 provider 内的状态与回调。
 *
 * @param params - provider 注入的运行时与状态依赖。
 * @returns 中断提交动作集合。
 */
export const useProjectInterruptActions = ({
  applyClassifiedError,
  clearProjectErrorMessages,
  pendingInterruptResponses,
  setPendingInterruptResponses,
}: ProjectInterruptActionsParams) => {
  const pendingInterrupts = useAgUiInterrupts()
  const submitInterruptResponses = useAgUiSubmitInterruptResponses()

  const submitInterruptResponse = useCallback(
    async (response: AgUiResumeEntry) => {
      const nextResponses = {
        ...pendingInterruptResponses,
        [response.interruptId]: response,
      }
      const missing = pendingInterrupts.filter((interrupt) => !nextResponses[interrupt.id])

      clearProjectErrorMessages()

      if (missing.length > 0) {
        setPendingInterruptResponses(nextResponses)
        return
      }

      const responses = pendingInterrupts.map((interrupt) => {
        const staged = nextResponses[interrupt.id]

        if (!staged) {
          throw new Error(`缺少等待确认响应：${interrupt.id}`)
        }

        return staged
      })
      setPendingInterruptResponses({})

      try {
        await submitInterruptResponses(responses)
      } catch (error) {
        applyClassifiedError({ error })
        throw error
      }
    },
    [
      applyClassifiedError,
      clearProjectErrorMessages,
      pendingInterruptResponses,
      pendingInterrupts,
      setPendingInterruptResponses,
      submitInterruptResponses,
    ],
  )

  const submitAskUserQuestionOutput = useCallback(
    async (targetId: string, output: AskUserQuestionToolOutput) => {
      if (!isAskUserQuestionToolOutput(output)) {
        throw new Error('AG-UI 确认信息格式不正确。')
      }

      const interrupt = pendingInterrupts.find((item) => item.toolCallId === targetId)

      if (!interrupt) {
        throw new Error('当前没有可恢复的等待确认。')
      }

      const schema = interrupt.responseSchema
      const questions =
        isRecord(schema) && Array.isArray(schema.questions)
          ? (schema.questions as AskUserQuestionToolInput['questions'])
          : []
      const payload = buildAskUserQuestionValuesPayload(output, questions)

      if (Object.keys(payload.values.answers).length !== questions.length) {
        throw new Error('当前等待确认缺少可提交的问题。')
      }

      await submitInterruptResponse({
        interruptId: interrupt.id,
        status: 'resolved',
        payload,
      })
    },
    [pendingInterrupts, submitInterruptResponse],
  )

  return { submitAskUserQuestionOutput }
}

interface ProjectVideoGenerationActionsParams {
  activeInterruptRef: RefObject<ProjectChatInterrupt | null>
  clearProjectErrorMessages: () => void
  isProjectLocalRunActive: () => boolean
  postRunMetadataControllerRef: RefObject<AbortController | null>
  refreshProjectBusinessState: (options?: {
    generations?: Record<string, unknown>[]
    lazy?: boolean
  }) => Promise<void>
  sessionId: string
}

/**
 * 提供视频提示词保存与视频生成提交动作。
 *
 * 从 ProjectChatBusinessProvider 中拆出的动作簇：行为与依赖保持原样，
 * 仅通过参数显式接收 provider 内的状态与回调。
 *
 * @param params - provider 注入的会话与状态依赖。
 * @returns 视频生成动作集合。
 */
export const useProjectVideoGenerationActions = ({
  activeInterruptRef,
  clearProjectErrorMessages,
  isProjectLocalRunActive,
  postRunMetadataControllerRef,
  refreshProjectBusinessState,
  sessionId,
}: ProjectVideoGenerationActionsParams) => {
  const saveVideoPrompt = useCallback(
    async (input: AgentVideoPromptSaveInput) => {
      const document = await readProducerSessionWorkspaceFile(sessionId, VIDEO_SHOT_PATH)
      const content = replaceVideoShotPrompt(document.content, input.shotIndex, input.prompt)

      await replaceProducerSessionWorkspaceFile(sessionId, VIDEO_SHOT_PATH, {
        content,
        etag: document.etag,
      })
      await refreshProjectBusinessState({
        lazy: true,
      })
    },
    [refreshProjectBusinessState, sessionId],
  )

  const submitVideoGeneration = useCallback(
    async (input: AgentVideoPromptGenerationInput) => {
      clearProjectErrorMessages()

      if (activeInterruptRef.current) {
        throw new Error(WAITING_FOR_CONTINUATION_REQUEST_ERROR_MESSAGE)
      }

      if (isProjectLocalRunActive()) {
        throw new Error('当前正在生成中，请等待完成后再提交视频。')
      }

      postRunMetadataControllerRef.current?.abort()
      postRunMetadataControllerRef.current = null
      const submission = await submitSessionVideoGeneration(sessionId, {
        aspectRatio: input.aspectRatio,
        model: DEFAULT_VIDEO_GENERATION_MODEL,
        prompt: input.prompt,
        referenceAudios: input.referenceAudios,
        referenceImages: input.referenceImages,
        referenceVideos: input.referenceVideos,
        seconds: input.seconds,
        shotIndex: input.shotIndex,
      })

      await refreshProjectBusinessState({
        generations: [producerGenerationRecordFromSubmission(submission)],
        lazy: true,
      })

      return submission
    },
    [
      activeInterruptRef,
      clearProjectErrorMessages,
      isProjectLocalRunActive,
      postRunMetadataControllerRef,
      refreshProjectBusinessState,
      sessionId,
    ],
  )

  const submitVideoGenerations = useCallback(
    async (inputs: AgentVideoPromptGenerationInput[]) => {
      if (inputs.length === 0) {
        return []
      }

      clearProjectErrorMessages()

      if (activeInterruptRef.current) {
        throw new Error(WAITING_FOR_CONTINUATION_REQUEST_ERROR_MESSAGE)
      }

      if (isProjectLocalRunActive()) {
        throw new Error('当前正在生成中，请等待完成后再提交视频。')
      }

      postRunMetadataControllerRef.current?.abort()
      postRunMetadataControllerRef.current = null

      const submissions: ProducerVideoGenerationSubmission[] = []

      for (const input of inputs) {
        submissions.push(
          await submitSessionVideoGeneration(sessionId, {
            aspectRatio: input.aspectRatio,
            model: DEFAULT_VIDEO_GENERATION_MODEL,
            prompt: input.prompt,
            referenceAudios: input.referenceAudios,
            referenceImages: input.referenceImages,
            referenceVideos: input.referenceVideos,
            seconds: input.seconds,
            shotIndex: input.shotIndex,
          }),
        )
      }

      await refreshProjectBusinessState({
        generations: submissions.map(producerGenerationRecordFromSubmission),
        lazy: true,
      })

      return submissions
    },
    [
      activeInterruptRef,
      clearProjectErrorMessages,
      isProjectLocalRunActive,
      postRunMetadataControllerRef,
      refreshProjectBusinessState,
      sessionId,
    ],
  )

  return { saveVideoPrompt, submitVideoGeneration, submitVideoGenerations }
}
