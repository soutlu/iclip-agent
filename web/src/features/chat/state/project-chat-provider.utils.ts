import type { AgUiInterrupt } from '@assistant-ui/react-ag-ui'
import type {
  AskUserQuestionToolInput,
  AskUserQuestionToolOutput,
  ProjectChatInterrupt,
} from '@/features/chat/contracts'
import { isRecord } from '@/shared/lib/guards'
import { DEFAULT_PROJECT_TITLE } from '../lib/project-chat.utils'
import { VIDEO_SHOT_PATH } from '../runtime/project-state.readers'

export type AskUserQuestionResumeAnswer = string | string[]
export const OTHER_OPTION_LABEL = 'Other'
export { VIDEO_SHOT_PATH }

export const isAbortError = (error: unknown) =>
  error instanceof Error && error.name === 'AbortError'

export const createAbortError = (signal?: AbortSignal) => {
  if (signal?.reason instanceof Error && signal.reason.name === 'AbortError') {
    return signal.reason
  }

  const error = new Error('Aborted')
  error.name = 'AbortError'

  return error
}

export const throwIfSignalAborted = (signal?: AbortSignal) => {
  if (signal?.aborted) {
    throw createAbortError(signal)
  }
}

export const areJsonSerializableValuesEqual = (left: unknown, right: unknown) => {
  if (Object.is(left, right)) {
    return true
  }

  try {
    return JSON.stringify(left) === JSON.stringify(right)
  } catch {
    return false
  }
}

export const preserveEqualSerializableValue = <T>(current: T, next: T) =>
  areJsonSerializableValuesEqual(current, next) ? current : next

export const normalizeProducerProjectTitle = (title: string) =>
  title.trim() || DEFAULT_PROJECT_TITLE

export const replaceVideoShotPrompt = (content: string, shotIndex: number, prompt: string) => {
  const normalizedPrompt = prompt.trim()

  if (normalizedPrompt.length === 0) {
    throw new Error('提示词不能为空。')
  }

  const document = JSON.parse(content) as unknown

  if (!isRecord(document) || !Array.isArray(document.shots)) {
    throw new Error(`${VIDEO_SHOT_PATH} 必须是包含 shots 数组的 JSON object`)
  }

  let didReplace = false
  const shots = document.shots.map((shot, index) => {
    if (!isRecord(shot)) {
      throw new Error(`${VIDEO_SHOT_PATH}.shots[${index.toString()}] 必须是对象`)
    }

    if (shot.index !== shotIndex) {
      return shot
    }

    didReplace = true

    return {
      ...shot,
      prompt: normalizedPrompt,
    }
  })

  if (!didReplace) {
    throw new Error(`${VIDEO_SHOT_PATH} 缺少镜头 ${shotIndex.toString()}`)
  }

  return JSON.stringify(
    {
      ...document,
      shots,
    },
    null,
    2,
  )
}

export const askUserQuestionInputFromSchema = (questions: unknown[]): AskUserQuestionToolInput => ({
  questions: questions.map((question) =>
    isRecord(question)
      ? {
          ...question,
          multiSelect: question.multi_select === true,
        }
      : question,
  ) as AskUserQuestionToolInput['questions'],
})

/**
 * 把 AG-UI runtime 的 `AgUiInterrupt` 转换为 Producer 业务中断类型。
 */
export const interruptFromAgUiInterrupt = (
  interrupt: AgUiInterrupt,
): ProjectChatInterrupt | null => {
  const toolCallId = interrupt.toolCallId ?? ''
  const schema = interrupt.responseSchema

  if (!isRecord(schema) || toolCallId === '') {
    return null
  }

  if (schema.type === 'ask_user_question' && Array.isArray(schema.questions)) {
    return {
      createdAt: new Date().toISOString(),
      interruptId: interrupt.id,
      kind: 'ask_user_question' as const,
      request: askUserQuestionInputFromSchema(schema.questions),
      targetId: toolCallId,
    }
  }

  if (schema.type === 'confirmation') {
    const toolName =
      typeof interrupt.metadata?.toolName === 'string' ? interrupt.metadata.toolName : ''

    return {
      createdAt: new Date().toISOString(),
      interruptId: interrupt.id,
      kind: 'tool_approval',
      request: {
        sourceToolCallId: toolCallId,
        sourceToolName: toolName,
        toolArgs: interrupt.metadata?.toolArgs,
      },
      targetId: toolCallId,
      toolName,
    }
  }

  return null
}

export const answerValuesFromAskUserQuestionOutput = (
  answer: AskUserQuestionToolOutput['answers'][string] | undefined,
) => {
  if (!answer) {
    return []
  }

  const selectedValues = answer.values
    .map((v) => v.trim())
    .filter((v) => v.length > 0 && v !== OTHER_OPTION_LABEL)
  const otherText = typeof answer.otherText === 'string' ? answer.otherText.trim() : ''

  return [...selectedValues, ...(otherText ? [otherText] : [])]
}

/**
 * 把用户 ask_user_question 答案构造为 Agno user_input values payload。
 */
export const buildAskUserQuestionValuesPayload = (
  output: AskUserQuestionToolOutput,
  questions: AskUserQuestionToolInput['questions'],
) => {
  const answers: Record<string, AskUserQuestionResumeAnswer> = {}

  for (const question of questions) {
    const questionText = typeof question.question === 'string' ? question.question.trim() : ''

    if (questionText === '') {
      continue
    }

    const answerValues = answerValuesFromAskUserQuestionOutput(output.answers[questionText])

    if (answerValues.length > 0) {
      const isMultiSelectQuestion = (question as { multi_select?: boolean }).multi_select === true

      // 上方 length 检查保证首个答案存在。
      answers[questionText] = isMultiSelectQuestion ? answerValues : answerValues[0]!
    }
  }

  return {
    values: {
      answers,
      questions,
    },
  }
}
