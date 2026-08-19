import type {
  AskUserQuestionItem,
  AskUserQuestionOption,
  AskUserQuestionToolAnswer,
  AskUserQuestionToolInput,
  AskUserQuestionToolOutput,
  ProjectChatInterrupt,
  ProjectChatTimelineItem,
  ProjectGenericToolPart,
} from '@/features/chat/contracts'
import { isRecord } from '@/shared/lib/guards'
import { ASK_USER_QUESTION_TOOL_NAME, stringField, stringValue } from './project-agui-messages'

/**
 * 规整 ask_user_question 的选项。
 *
 * @param value - 工具输入中的原始选项。
 * @param index - 选项序号。
 * @returns 可渲染的选项；缺少标签时返回 null。
 */
export const askUserQuestionOptionFromUnknown = (
  value: unknown,
  index: number,
): AskUserQuestionOption | null => {
  if (typeof value === 'string') {
    const label = stringValue(value)

    return label ? { label } : null
  }

  if (!isRecord(value)) {
    return null
  }

  const label =
    stringField(value, 'label') || stringField(value, 'value') || `选项 ${String(index + 1)}`

  return {
    ...(stringField(value, 'description')
      ? { description: stringField(value, 'description') }
      : {}),
    label,
    ...(stringField(value, 'preview') ? { preview: stringField(value, 'preview') } : {}),
  }
}

/**
 * 规整 ask_user_question 的问题。
 *
 * @param value - 工具输入中的原始问题。
 * @param index - 问题序号。
 * @returns 可渲染的问题；缺少有效文本时返回 null。
 */
export const askUserQuestionItemFromUnknown = (
  value: unknown,
  index: number,
): AskUserQuestionItem | null => {
  if (!isRecord(value)) {
    return null
  }

  const question = stringField(value, 'question')
  const header = stringField(value, 'header') || question || `问题 ${String(index + 1)}`
  const options = (Array.isArray(value.options) ? value.options : [])
    .map(askUserQuestionOptionFromUnknown)
    .filter((option): option is AskUserQuestionOption => option !== null)

  if (question === '' && header === '') {
    return null
  }

  return {
    header,
    multiSelect: value.multiSelect === true || value.multi_select === true,
    options,
    question: question || header,
    required: value.required === false ? false : undefined,
  }
}

/**
 * 规整字符串记录。
 *
 * @param value - 需要读取的未知值。
 * @returns 字符串记录；格式无效时返回 undefined。
 */
export const stringRecordFromUnknown = (value: unknown): Record<string, string> | undefined => {
  if (!isRecord(value)) {
    return undefined
  }

  const entries = Object.entries(value)
    .map(([key, entryValue]) => [key, stringValue(entryValue)] as const)
    .filter(([, entryValue]) => entryValue.length > 0)

  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

/**
 * 去重并规整 ask_user_question 答案值。
 *
 * @param values - 原始答案值列表。
 * @returns 可展示的答案值列表。
 */
export const normalizedAskAnswerValues = (values: string[]) =>
  Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)))

/**
 * 规整单题答案。
 *
 * @param value - 工具结果或输入中的原始答案。
 * @returns 可渲染的答案；没有有效选择时返回 null。
 */
export const askUserQuestionAnswerFromUnknown = (
  value: unknown,
): AskUserQuestionToolAnswer | null => {
  if (typeof value === 'string') {
    const values = normalizedAskAnswerValues([value])

    return values.length > 0 ? { values } : null
  }

  if (Array.isArray(value)) {
    const values = normalizedAskAnswerValues(
      value.filter((item): item is string => typeof item === 'string'),
    )

    return values.length > 0 ? { values } : null
  }

  if (!isRecord(value)) {
    return null
  }

  const values = Array.isArray(value.values)
    ? normalizedAskAnswerValues(
        value.values.filter((item): item is string => typeof item === 'string'),
      )
    : []
  const otherText = stringField(value, 'otherText') || stringField(value, 'other_text')

  return values.length > 0 || otherText.length > 0
    ? {
        ...(otherText ? { otherText } : {}),
        values,
      }
    : null
}

/**
 * 从工具输入中规整已存在的 ask_user_question 答案。
 *
 * @param value - 工具输入中的 answers 字段。
 * @returns 以问题文本为 key 的答案记录；没有答案时返回 undefined。
 */
export const askUserQuestionAnswersFromUnknown = (
  value: unknown,
): Record<string, AskUserQuestionToolAnswer> | undefined => {
  if (!isRecord(value)) {
    return undefined
  }

  const entries = Object.entries(value)
    .map(
      ([questionKey, answer]) => [questionKey, askUserQuestionAnswerFromUnknown(answer)] as const,
    )
    .filter((entry): entry is readonly [string, AskUserQuestionToolAnswer] => entry[1] !== null)

  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

/**
 * 从 ask_user_question 工具输入中创建历史请求。
 *
 * @param input - 工具调用输入。
 * @returns 可渲染的 ask 请求；没有问题时返回 null。
 */
export const askUserQuestionInputFromToolInput = (
  input: unknown,
): AskUserQuestionToolInput | null => {
  if (!isRecord(input)) {
    return null
  }

  const questions = (Array.isArray(input.questions) ? input.questions : [])
    .map(askUserQuestionItemFromUnknown)
    .filter((question): question is AskUserQuestionItem => question !== null)

  if (questions.length === 0) {
    return null
  }

  const annotations = stringRecordFromUnknown(input.annotations)
  const answers = askUserQuestionAnswersFromUnknown(input.answers)

  return {
    ...(annotations ? { annotations } : {}),
    ...(answers ? { answers } : {}),
    metadata: {
      source: ASK_USER_QUESTION_TOOL_NAME,
    },
    questions,
  }
}

/**
 * 按问题文案建立答案归属索引。
 *
 * @param questions - ask_user_question 问题列表。
 * @returns 可从问题文案找到规范化问题文本的索引。
 */
export const createAskQuestionKeyMap = (questions: AskUserQuestionItem[]) => {
  const keyMap = new Map<string, string>()

  for (const question of questions) {
    const normalizedKey = question.question.trim()

    if (normalizedKey.length > 0) {
      keyMap.set(normalizedKey, normalizedKey)
    }
  }

  return keyMap
}

/**
 * 从 selections 记录中恢复 ask_user_question 输出。
 *
 * @param params - selections 解析参数。
 * @param params.questions - 当前 ask 的问题列表。
 * @param params.selections - 后端按问题文案返回的选择记录。
 * @returns 可渲染的 ask 输出；没有答案时返回 null。
 */
export const askUserQuestionOutputFromSelections = ({
  questions,
  selections,
}: {
  questions: AskUserQuestionItem[]
  selections: Record<string, unknown>
}): AskUserQuestionToolOutput | null => {
  const keyMap = createAskQuestionKeyMap(questions)
  const answers: Record<string, AskUserQuestionToolAnswer> = {}

  for (const [questionKey, rawAnswer] of Object.entries(selections)) {
    const normalizedQuestionKey = keyMap.get(questionKey.trim())
    const answer = askUserQuestionAnswerFromUnknown(rawAnswer)

    if (normalizedQuestionKey && answer) {
      answers[normalizedQuestionKey] = answer
    }
  }

  return Object.keys(answers).length > 0 ? { answers } : null
}

/**
 * 从稳定文本格式中恢复 ask_user_question 输出。
 *
 * @param params - 文本解析参数。
 * @param params.questions - 当前 ask 的问题列表。
 * @param params.text - 工具结果文本。
 * @returns 可渲染的 ask 输出；未匹配时返回 null。
 */
export const askUserQuestionOutputFromResultText = ({
  questions,
  text,
}: {
  questions: AskUserQuestionItem[]
  text: string
}): AskUserQuestionToolOutput | null => {
  const keyMap = createAskQuestionKeyMap(questions)
  const answers: Record<string, AskUserQuestionToolAnswer> = {}
  const answerMatcher = /"([^"]+)"\s*=\s*"([^"]*)"/gu

  for (const match of text.matchAll(answerMatcher)) {
    const questionKey = keyMap.get((match[1] ?? '').trim())
    const answer = askUserQuestionAnswerFromUnknown(match[2] ?? '')

    if (questionKey && answer) {
      answers[questionKey] = answer
    }
  }

  return Object.keys(answers).length > 0 ? { answers } : null
}

/**
 * 从工具结果中恢复 ask_user_question 输出。
 *
 * @param params - 输出解析参数。
 * @param params.output - assistant-ui 工具 part 的结果字段。
 * @param params.questions - 当前 ask 的问题列表。
 * @returns 可渲染的 ask 输出；没有结果时返回 null。
 */
export const askUserQuestionOutputFromToolOutput = ({
  output,
  questions,
}: {
  output?: unknown
  questions: AskUserQuestionItem[]
}): AskUserQuestionToolOutput | null => {
  if (typeof output === 'string') {
    return askUserQuestionOutputFromResultText({
      questions,
      text: output,
    })
  }

  if (!isRecord(output)) {
    return null
  }

  const answers = askUserQuestionAnswersFromUnknown(output.answers)

  if (answers) {
    return { answers }
  }

  return isRecord(output.selections)
    ? askUserQuestionOutputFromSelections({
        questions,
        selections: output.selections,
      })
    : null
}

/**
 * 判断 active ask 中断是否对应当前工具调用。
 *
 * @param params - 匹配参数。
 * @param params.activeInterrupt - 当前 Producer 中断。
 * @param params.toolCallId - 工具调用 id。
 * @returns 同一工具调用时返回 true。
 */
export const isActiveAskInterruptForToolCall = ({
  activeInterrupt,
  toolCallId,
}: {
  activeInterrupt: ProjectChatInterrupt | null
  toolCallId: string
}) => activeInterrupt?.kind === 'ask_user_question' && activeInterrupt.targetId === toolCallId

/**
 * 从工具 part 和 active requirement 创建 ask timeline item。
 *
 * @param params - ask timeline 参数。
 * @param params.activeInterrupt - 当前 Producer 中断。
 * @param params.part - ask_user_question 工具 part。
 * @returns 可渲染的 ask timeline item；缺少问题时返回 null。
 */
export const askTimelineItemFromToolPart = ({
  activeInterrupt,
  part,
}: {
  activeInterrupt: ProjectChatInterrupt | null
  part: ProjectGenericToolPart
}): ProjectChatTimelineItem | null => {
  const activeRequest =
    activeInterrupt?.kind === 'ask_user_question' &&
    isActiveAskInterruptForToolCall({
      activeInterrupt,
      toolCallId: part.toolCallId,
    })
      ? activeInterrupt.request
      : null
  const request = askUserQuestionInputFromToolInput(part.input) ?? activeRequest

  if (!request || request.questions.length === 0) {
    return null
  }

  const response =
    askUserQuestionOutputFromToolOutput({
      output: part.output,
      questions: request.questions,
    }) ?? (request.answers ? { answers: request.answers } : undefined)

  return {
    id: `ask:${part.toolCallId}`,
    kind: 'ask-user-question',
    request,
    ...(response ? { response } : {}),
    toolCallId: part.toolCallId,
  }
}

/**
 * 从当前 AG-UI pending interrupt 创建 ask timeline item。
 *
 * live paused run 可能只发 RUN_FINISHED interrupt outcome，不单独发工具调用事件；
 * 此时 activeInterrupt 是唯一事实源，timeline 需要直接挂载同一个 ask 面板。
 *
 * @param activeInterrupt - 当前 Producer 中断。
 * @returns 可渲染的 ask timeline item；非 ask 中断或缺少问题时返回 null。
 */
export const askTimelineItemFromActiveInterrupt = (
  activeInterrupt: ProjectChatInterrupt | null,
): ProjectChatTimelineItem | null => {
  if (
    activeInterrupt?.kind !== 'ask_user_question' ||
    activeInterrupt.request.questions.length === 0
  ) {
    return null
  }

  return {
    id: `ask:${activeInterrupt.targetId}`,
    kind: 'ask-user-question',
    request: activeInterrupt.request,
    toolCallId: activeInterrupt.targetId,
  }
}
