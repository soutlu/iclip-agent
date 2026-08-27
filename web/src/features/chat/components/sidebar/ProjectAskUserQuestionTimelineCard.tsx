import ProjectInlineAskPanel from '@/features/chat/components/sidebar/ProjectInlineAskPanel'
import type {
  AskUserQuestionToolAnswer,
  ProjectAskUserQuestionTimelineItem,
  ProjectChatInterrupt,
} from '@/features/chat/contracts'
import {
  getAskUserQuestionKey,
  normalizeAskUserQuestions,
} from '../../lib/project-ask-user-question.utils'

/**
 * 判断 ask 答案是否已经填写。
 *
 * @param answer - 单题答案。
 * @returns 存在选择值或其他文本时返回 true。
 */
export const isAskAnswerFilled = (answer: AskUserQuestionToolAnswer | undefined) =>
  Boolean(answer && (answer.values.length > 0 || (answer.otherText?.trim().length ?? 0) > 0))

/**
 * 读取 ask 答案的用户可见文案。
 *
 * @param params - 答案展示参数。
 * @param params.answer - 单题答案。
 * @param params.question - 已归一化的问题。
 * @returns 可直接渲染的答案文案列表。
 */
export const askAnswerDisplayValues = ({
  answer,
  question,
}: {
  answer: AskUserQuestionToolAnswer | undefined
  question: ReturnType<typeof normalizeAskUserQuestions>[number]
}) => {
  if (!answer) {
    return []
  }

  const optionLabels = new Map(
    question.options.map((option) => [option.value, option.displayLabel] as const),
  )
  const selectedValues = answer.values
    .filter((value) => value.toLowerCase() !== 'other')
    .map((value) => optionLabels.get(value) ?? value)
  const otherText = answer.otherText?.trim()

  return otherText ? [...selectedValues, otherText] : selectedValues
}

/**
 * 判断 timeline ask item 是否对应当前 active interrupt。
 *
 * @param params - 匹配参数。
 * @param params.activeInterrupt - 当前 Producer 中断。
 * @param params.item - ask timeline item。
 * @returns 同一 ask 工具调用时返回 true。
 */
export const isActiveAskTimelineItem = ({
  activeInterrupt,
  item,
}: {
  activeInterrupt: ProjectChatInterrupt | null
  item: ProjectAskUserQuestionTimelineItem
}) => activeInterrupt?.kind === 'ask_user_question' && activeInterrupt.targetId === item.toolCallId

/**
 * 渲染已发生的 ask_user_question 历史节点。
 *
 * @param props - ask 历史节点属性。
 * @param props.active - 当前节点是否仍等待用户交互。
 * @param props.item - ask timeline item。
 * @returns active 时返回可交互表单，否则返回历史答案卡片。
 */
export const ProjectAskUserQuestionTimelineCard = ({
  active,
  item,
}: {
  active: boolean
  item: ProjectAskUserQuestionTimelineItem
}) => {
  if (active) {
    return (
      <div className="flex justify-start pr-1" data-project-ask-timeline-item="active">
        <ProjectInlineAskPanel className="max-w-[94%]" targetId={item.toolCallId} />
      </div>
    )
  }

  const questions = normalizeAskUserQuestions(item.request.questions)
  const completedCount = questions.filter((question) =>
    isAskAnswerFilled(item.response?.answers[getAskUserQuestionKey(question)]),
  ).length
  const statusText = item.response
    ? `已完成 ${completedCount} / ${questions.length}`
    : '等待你的选择'

  return (
    <div className="flex justify-start pr-1" data-project-ask-timeline-item="history">
      <div className="w-full max-w-[92%] min-w-0 border-l-2 border-chat-agent-rail py-1 pl-3">
        <div className="flex items-center justify-between gap-3 border-b border-chat-inline-border pb-2">
          <div className="min-w-0">
            <div className="text-caption font-medium text-chat-muted-text">工具确认</div>
            <div className="truncate text-body-sm font-semibold text-chat-message-text">
              {statusText}
            </div>
          </div>
          <span className="shrink-0 rounded-full bg-chat-chip-bg px-2.5 py-1 text-caption text-chat-muted-text">
            工具确认
          </span>
        </div>
        <div className="mt-1 divide-y divide-chat-inline-border">
          {questions.map((question) => {
            const questionKey = getAskUserQuestionKey(question)
            const values = askAnswerDisplayValues({
              answer: item.response?.answers[questionKey],
              question,
            })

            return (
              <div className="py-2.5" key={questionKey}>
                <div className="text-caption font-medium text-chat-muted-text">
                  {question.header}
                </div>
                <div className="mt-1 text-label leading-[1.45] text-chat-message-text">
                  {question.question}
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {values.length > 0 ? (
                    values.map((value) => (
                      <span
                        className="rounded-full border border-chat-chip-border bg-chat-chip-bg px-2.5 py-1 text-caption text-chat-message-text"
                        key={value}
                      >
                        {value}
                      </span>
                    ))
                  ) : (
                    <span className="text-caption text-chat-muted-text">等待你的选择</span>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
