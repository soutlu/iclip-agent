import type {
  AskUserQuestionItem,
  AskUserQuestionOption,
  AskUserQuestionToolAnswer,
  AskUserQuestionToolInput,
  AskUserQuestionToolOutput,
} from '../contracts'

const OTHER_OPTION_LABEL = 'Other'

export interface AskUserQuestionAnswerDraft extends AskUserQuestionToolAnswer {
  useOther: boolean
}

export interface NormalizedAskUserQuestionOption extends AskUserQuestionOption {
  displayLabel: string
  isOther: boolean
  recommended: boolean
  value: string
}

export interface NormalizedAskUserQuestionItem extends Omit<AskUserQuestionItem, 'options'> {
  multiSelect: boolean
  options: NormalizedAskUserQuestionOption[]
  required: boolean
  supportsOther: boolean
}

/**
 * 规整 ask_user_question 的可选文本。
 *
 * @param value - 后端或本地草稿中的文本值。
 * @returns 去除首尾空白后的文本；缺失时返回空字符串。
 */
export const normalizeAskUserQuestionText = (value: string | undefined) => value?.trim() ?? ''

/**
 * 读取 ask_user_question 的协议键。
 *
 * ask_user_question 后端协议以问题文本作为答案归属键；前端状态和提交 payload
 * 必须使用同一个键，避免维护第二套 id。
 *
 * @param question - ask_user_question 问题。
 * @returns 去空白后的问题文本。
 */
export const getAskUserQuestionKey = (question: Pick<AskUserQuestionItem, 'question'>) =>
  normalizeAskUserQuestionText(question.question)

/**
 * 判断选项值是否表示 Other 兜底项。
 *
 * @param value - 原始选项文案。
 * @returns 选项等于 Other 时返回 true。
 */
const isOtherOptionValue = (value: string) =>
  normalizeAskUserQuestionText(value).toLowerCase() === OTHER_OPTION_LABEL.toLowerCase()

/**
 * 去重并规整答案选项值。
 *
 * @param values - 本地草稿或后端输入中的答案值。
 * @returns 已去空、去重的答案值列表。
 */
const normalizeAnswerValues = (values: string[]) =>
  Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)))

/**
 * 解析选项标签中的推荐标记。
 *
 * @param value - 原始选项标签。
 * @returns 用户可见标签和是否推荐。
 */
const parseRecommendedOptionLabel = (value: string) => {
  const label = value.replace(/\s*\(recommended\)\s*/iu, '').trim()
  const recommended = /\(recommended\)/iu.test(value)

  return {
    displayLabel: isOtherOptionValue(label) ? '其他' : label,
    recommended,
  }
}

/**
 * 规整 ask_user_question 的选项列表。
 *
 * @param options - 后端返回的原始选项列表。
 * @returns 带展示标签、推荐态和 Other 标记的选项列表。
 */
const normalizeAskUserQuestionOptions = (options: AskUserQuestionOption[]) =>
  options.map((option) => {
    const { displayLabel, recommended } = parseRecommendedOptionLabel(option.label)

    return {
      ...option,
      displayLabel,
      isOther: isOtherOptionValue(option.label),
      recommended,
      value: option.label,
    } satisfies NormalizedAskUserQuestionOption
  })

/**
 * 规整 ask_user_question 的问题列表。
 *
 * @param questions - 后端返回的原始问题列表。
 * @returns 可供面板渲染的问题列表。
 */
export const normalizeAskUserQuestions = (questions: AskUserQuestionItem[]) => {
  const normalizedQuestions = questions.map((question) => {
    const questionText = getAskUserQuestionKey(question)
    const options = normalizeAskUserQuestionOptions(question.options)

    if (questionText.length === 0) {
      throw new Error('ask_user_question question text is required.')
    }

    return {
      ...question,
      header: normalizeAskUserQuestionText(question.header) || questionText,
      multiSelect: question.multiSelect === true,
      options: options.filter((option) => !option.isOther),
      question: questionText,
      required: question.required !== false,
      supportsOther: options.some((option) => option.isOther),
    } satisfies NormalizedAskUserQuestionItem
  })

  const questionKeys = normalizedQuestions.map(getAskUserQuestionKey)
  if (new Set(questionKeys).size !== questionKeys.length) {
    throw new Error('ask_user_question questions must have unique question text.')
  }

  return normalizedQuestions
}

/**
 * 创建 ask_user_question 表单的初始草稿。
 *
 * @param input - ask_user_question 工具输入。
 * @returns 以问题文本为 key 的答案草稿。
 */
export const createInitialAskUserQuestionDrafts = (input: AskUserQuestionToolInput) => {
  const questions = normalizeAskUserQuestions(input.questions ?? [])

  return Object.fromEntries(
    questions.map((question) => {
      const questionKey = getAskUserQuestionKey(question)
      const answer = input.answers?.[questionKey]

      return [
        questionKey,
        {
          values: normalizeAnswerValues(
            (answer?.values ?? []).filter((value) => !isOtherOptionValue(value)),
          ),
          otherText: normalizeAskUserQuestionText(answer?.otherText),
          useOther:
            normalizeAskUserQuestionText(answer?.otherText).length > 0 ||
            (answer?.values ?? []).some(isOtherOptionValue),
        } satisfies AskUserQuestionAnswerDraft,
      ]
    }),
  ) as Record<string, AskUserQuestionAnswerDraft>
}

/**
 * 判断单个问题是否已经满足提交条件。
 *
 * @param question - 已规整的问题配置。
 * @param draft - 当前问题的本地答案草稿。
 * @returns 必填或可选问题已经完成时返回 true。
 */
export const isAskUserQuestionAnswered = (
  question: NormalizedAskUserQuestionItem,
  draft: AskUserQuestionAnswerDraft | undefined,
) => {
  if (!draft) {
    return false
  }

  const selectedValues = normalizeAnswerValues(draft.values)
  const otherText = normalizeAskUserQuestionText(draft.otherText)
  const otherAnswered = draft.useOther && otherText.length > 0

  if (question.required === false) {
    return selectedValues.length > 0 || otherAnswered || !draft.useOther
  }

  return selectedValues.length > 0 || otherAnswered
}

/**
 * 将本地草稿转换为 ask_user_question 工具输出。
 *
 * @param questions - 已规整的问题列表。
 * @param drafts - 当前本地答案草稿。
 * @returns 可发送给 AG-UI HITL continue 的工具输出。
 */
export const toAskUserQuestionToolOutput = (
  questions: NormalizedAskUserQuestionItem[],
  drafts: Record<string, AskUserQuestionAnswerDraft>,
): AskUserQuestionToolOutput => ({
  answers: Object.fromEntries(
    questions.map((question) => {
      const questionKey = getAskUserQuestionKey(question)
      const draft = drafts[questionKey]
      const otherText = draft?.useOther ? normalizeAskUserQuestionText(draft.otherText) : ''

      return [
        questionKey,
        {
          values: [
            ...normalizeAnswerValues(draft?.values ?? []),
            ...(otherText.length > 0 ? [OTHER_OPTION_LABEL] : []),
          ],
          ...(otherText ? { otherText } : {}),
        } satisfies AskUserQuestionToolAnswer,
      ]
    }),
  ),
})

/**
 * 获取 ask_user_question 面板的来源标签。
 *
 * @param value - 后端 metadata.source。
 * @returns 用户可读的来源标签。
 */
export const getAskUserQuestionSourceLabel = (value: string | undefined) => {
  switch (value) {
    case 'ask_user_question':
      return '工具确认'
    case 'creative-director':
      return '创意策划师'
    case 'storyboard-director':
      return '分镜执行导演'
    default:
      return '工具确认'
  }
}
