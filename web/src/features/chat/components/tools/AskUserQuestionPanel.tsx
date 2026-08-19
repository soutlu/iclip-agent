import { useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@/shared/lib/utils'
import type { ProjectAskUserQuestionInterrupt } from '../../contracts'
import {
  type AskUserQuestionAnswerDraft,
  createInitialAskUserQuestionDrafts,
  getAskUserQuestionKey,
  getAskUserQuestionSourceLabel,
  isAskUserQuestionAnswered,
  normalizeAskUserQuestions,
  normalizeAskUserQuestionText,
  toAskUserQuestionToolOutput,
} from '../../lib/project-ask-user-question.utils'
import { useProjectChatAskUserQuestion } from '../../state/ProjectChatProvider'

interface AskUserQuestionPanelProps {
  className?: string
  interrupt: ProjectAskUserQuestionInterrupt
}

/**
 * 找到当前 ask 表单中第一道尚未完成的问题。
 *
 * @param questionKeys - 已归一化问题文本键列表。
 * @param drafts - 当前本地答案草稿。
 * @param questions - 已归一化的问题列表。
 * @returns 第一道未完成问题键；全部完成时返回第一道问题键。
 */
const getFirstIncompleteQuestionKey = (
  questionKeys: string[],
  drafts: Record<string, AskUserQuestionAnswerDraft>,
  questions: ReturnType<typeof normalizeAskUserQuestions>,
) => {
  const incompleteQuestion = questions.find(
    (question) => !isAskUserQuestionAnswered(question, drafts[getAskUserQuestionKey(question)]),
  )

  return incompleteQuestion ? getAskUserQuestionKey(incompleteQuestion) : (questionKeys[0] ?? '')
}

/**
 * 渲染 `ask_user_question` 的内联确认面板。
 *
 * @param props - 内联 ask 面板属性。
 * @param props.className - 追加到外层容器的样式类。
 * @param props.interrupt - 当前 AG-UI ask_user_question 中断。
 * @returns 当前 ask 中断可提交的表单。
 */
export default function AskUserQuestionPanel({
  className = '',
  interrupt,
}: AskUserQuestionPanelProps) {
  const { isInteractionLocked, submitAskUserQuestionOutput } = useProjectChatAskUserQuestion()
  const lastVisibleQuestionKeyRef = useRef('')
  const panelRootRef = useRef<HTMLDivElement | null>(null)
  const scrollBodyRef = useRef<HTMLDivElement | null>(null)
  const questions = useMemo(
    () => normalizeAskUserQuestions(interrupt.request.questions ?? []),
    [interrupt.request.questions],
  )
  const [drafts, setDrafts] = useState<Record<string, AskUserQuestionAnswerDraft>>(() =>
    createInitialAskUserQuestionDrafts(interrupt.request),
  )
  const [selectedQuestionKey, setSelectedQuestionKey] = useState(() =>
    getFirstIncompleteQuestionKey(
      questions.map(getAskUserQuestionKey),
      createInitialAskUserQuestionDrafts(interrupt.request),
      questions,
    ),
  )
  const [isSubmitting, setIsSubmitting] = useState(false)

  useEffect(() => {
    setDrafts(createInitialAskUserQuestionDrafts(interrupt.request))
    setSelectedQuestionKey(
      getFirstIncompleteQuestionKey(
        questions.map(getAskUserQuestionKey),
        createInitialAskUserQuestionDrafts(interrupt.request),
        questions,
      ),
    )
  }, [interrupt.request, questions])

  useEffect(() => {
    if (isSubmitting && isInteractionLocked) {
      setIsSubmitting(false)
    }
  }, [isInteractionLocked, isSubmitting])

  useEffect(() => {
    if (lastVisibleQuestionKeyRef.current === selectedQuestionKey) {
      return
    }

    lastVisibleQuestionKeyRef.current = selectedQuestionKey

    if (scrollBodyRef.current) {
      scrollBodyRef.current.scrollTop = 0
    }

    if (typeof panelRootRef.current?.scrollIntoView === 'function') {
      panelRootRef.current.scrollIntoView({
        block: 'nearest',
        inline: 'nearest',
      })
    }
  }, [selectedQuestionKey])

  const currentIndex = Math.max(
    0,
    questions.findIndex((question) => getAskUserQuestionKey(question) === selectedQuestionKey),
  )
  const activeQuestion = questions[currentIndex]
  const activeQuestionKey = activeQuestion ? getAskUserQuestionKey(activeQuestion) : ''
  const activeDraft = activeQuestion
    ? (drafts[activeQuestionKey] ?? {
        otherText: '',
        useOther: false,
        values: [],
      })
    : null
  const completedCount = questions.filter((question) =>
    isAskUserQuestionAnswered(question, drafts[getAskUserQuestionKey(question)]),
  ).length
  const allCompleted = questions.length > 0 && completedCount === questions.length
  const firstIncompleteQuestion = questions.find(
    (question) => !isAskUserQuestionAnswered(question, drafts[getAskUserQuestionKey(question)]),
  )

  if (!activeQuestion || !activeDraft) {
    return null
  }

  const activeAnnotation = interrupt.request.annotations?.[activeQuestionKey]
  const sourceLabel = getAskUserQuestionSourceLabel(interrupt.request.metadata?.source)
  const canGoNext = isAskUserQuestionAnswered(activeQuestion, activeDraft)
  const selectionModeLabel = activeQuestion.multiSelect ? '多选' : '单选'
  const selectionModeHint = activeQuestion.multiSelect
    ? '可选择多项，选完后点击下一步。'
    : '仅可选择一项。'
  const showOtherInput =
    activeQuestion.supportsOther ||
    activeDraft.useOther ||
    normalizeAskUserQuestionText(activeDraft.otherText).length > 0
  const isContinuationStreamActive = isInteractionLocked
  const isHandingOffAsk = isSubmitting && !isInteractionLocked

  /**
   * 更新指定问题的本地答案草稿。
   *
   * @param questionKey - 需要更新的问题文本键。
   * @param updater - 基于当前草稿生成下一版草稿的函数。
   */
  const updateDraft = (
    questionKey: string,
    updater: (current: AskUserQuestionAnswerDraft) => AskUserQuestionAnswerDraft,
  ) => {
    setDrafts((currentDrafts) => ({
      ...currentDrafts,
      [questionKey]: updater(
        currentDrafts[questionKey] ?? {
          otherText: '',
          useOther: false,
          values: [],
        },
      ),
    }))
  }

  /**
   * 切换到指定序号的问题。
   *
   * @param nextIndex - 目标问题在归一化问题列表中的下标。
   */
  const moveToQuestion = (nextIndex: number) => {
    const nextQuestion = questions[nextIndex]

    if (nextQuestion) {
      setSelectedQuestionKey(getAskUserQuestionKey(nextQuestion))
    }
  }

  /**
   * 处理选项点击，并在单选多题场景自动推进。
   *
   * @param optionValue - 被用户选择或取消选择的选项值。
   */
  const handleOptionClick = (optionValue: string) => {
    updateDraft(activeQuestionKey, (current) => {
      if (activeQuestion.multiSelect) {
        const values = current.values.includes(optionValue)
          ? current.values.filter((value) => value !== optionValue)
          : [...current.values, optionValue]

        return {
          ...current,
          values,
        }
      }

      return {
        ...current,
        otherText: '',
        useOther: false,
        values: [optionValue],
      }
    })

    if (!activeQuestion.multiSelect && currentIndex < questions.length - 1) {
      globalThis.setTimeout(() => moveToQuestion(currentIndex + 1), 220)
    }
  }

  /**
   * 提交 ask_user_question 输出并交还 AG-UI 续跑。
   *
   * @returns 提交完成后的 Promise。
   */
  const handleSubmit = async () => {
    if (!allCompleted || isSubmitting || isInteractionLocked) {
      if (firstIncompleteQuestion) {
        setSelectedQuestionKey(getAskUserQuestionKey(firstIncompleteQuestion))
      }
      return
    }

    setIsSubmitting(true)

    try {
      await submitAskUserQuestionOutput(
        interrupt.targetId,
        toAskUserQuestionToolOutput(questions, drafts),
      )
    } catch {
      return
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div
      className={cn('layer-local-1 relative w-full min-w-0 shrink-0', className)}
      data-testid="inline-ask-user-question-panel"
      ref={panelRootRef}
    >
      <div className="flex max-h-[min(72vh,680px)] min-h-0 flex-col overflow-hidden rounded-lg border border-[color:var(--color-chat-inline-border)] bg-[color:var(--color-chat-card-bg)] shadow-[var(--shadow-chat-assistant)]">
        <div className="flex items-start justify-between gap-3 px-4 pt-3.5 pb-2">
          <div className="min-w-0">
            <div className="text-caption font-medium text-[color:var(--color-chat-muted-text)]">
              等待你的确认
            </div>
            <div className="mt-1 truncate text-body leading-none font-semibold text-[color:var(--color-chat-message-text)]">
              继续生成前，需要你补充选择
            </div>
          </div>
          <div className="shrink-0 rounded-full bg-[color:var(--color-chat-chip-bg)] px-2.5 py-1 text-caption font-medium text-[color:var(--color-chat-message-text)]">
            {sourceLabel}
          </div>
        </div>

        <div className="px-4 pt-2">
          <div className="flex items-center gap-1.5">
            {questions.map((question, index) => {
              const isActive = index === currentIndex
              const questionKey = getAskUserQuestionKey(question)
              const isCompleted = isAskUserQuestionAnswered(question, drafts[questionKey])

              return (
                <button
                  key={questionKey}
                  type="button"
                  aria-label={`跳转到 ${question.header}`}
                  className={cn(
                    'h-1 flex-1 rounded-full transition-colors',
                    isActive
                      ? 'bg-[color:var(--color-chat-message-text)]'
                      : isCompleted
                        ? 'bg-[color:var(--color-chat-muted-text)]'
                        : 'bg-[color:var(--color-chat-chip-bg)]',
                  )}
                  onClick={() => setSelectedQuestionKey(questionKey)}
                />
              )
            })}
          </div>
        </div>

        <div
          className="nowheel thin-scrollbar min-h-0 flex-1 overflow-y-auto px-4 pt-3 pb-4"
          data-scrollable
          ref={scrollBodyRef}
        >
          <section>
            <div className="flex items-center justify-between gap-2 border-b border-[color:var(--color-chat-inline-border)] pb-2 text-caption text-[color:var(--color-chat-muted-text)]">
              <span className="min-w-0 truncate">{activeQuestion.header}</span>
              <span className="shrink-0">
                {currentIndex + 1} / {questions.length}
              </span>
            </div>
            <h3 className="mt-3 text-body leading-[1.45] font-semibold text-[color:var(--color-chat-message-text)]">
              {activeQuestion.question}
            </h3>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-[color:var(--color-chat-chip-bg)] px-2.5 py-1 text-caption font-medium text-[color:var(--color-chat-message-text)]">
                {selectionModeLabel}
              </span>
              <span className="text-caption text-[color:var(--color-chat-muted-text)]">
                {selectionModeHint}
              </span>
            </div>

            {activeAnnotation ? (
              <div className="mt-3 border-l-2 border-[color:var(--color-chat-agent-rail)] pl-3 text-label leading-[1.5] text-[color:var(--color-chat-secondary-text)]">
                <span className="mr-1 font-medium text-[color:var(--color-chat-message-text)]">
                  智能体建议：
                </span>
                {activeAnnotation}
              </div>
            ) : null}

            <div className="mt-4 divide-y divide-[color:var(--color-chat-inline-border)]">
              {activeQuestion.options.map((option) => {
                const isSelected = activeDraft.values.includes(option.value)

                return (
                  <button
                    key={option.value}
                    type="button"
                    aria-pressed={isSelected}
                    className={cn(
                      'group relative flex w-full items-start gap-3 px-3 py-3 text-left transition-colors',
                      isSelected
                        ? 'bg-[color:var(--color-chat-inline-bg)] before:absolute before:top-2 before:bottom-2 before:left-0 before:w-0.5 before:rounded-full before:bg-[color:var(--color-chat-agent-rail)]'
                        : 'hover:bg-[color:var(--color-chat-inline-bg)]',
                    )}
                    onClick={() => handleOptionClick(option.value)}
                  >
                    <span
                      className={cn(
                        'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center border transition-colors',
                        activeQuestion.multiSelect ? 'rounded-xs' : 'rounded-full',
                        isSelected
                          ? 'border-[color:var(--color-chat-agent-rail)] bg-[color:var(--color-chat-agent-rail)] text-[color:var(--color-chat-card-bg)]'
                          : 'border-[color:var(--color-chat-muted-text)] text-transparent group-hover:border-[color:var(--color-chat-message-text)]',
                      )}
                      aria-hidden="true"
                    >
                      {activeQuestion.multiSelect ? <CheckIcon /> : <RadioDotIcon />}
                    </span>

                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="text-body-sm font-medium text-[color:var(--color-chat-message-text)]">
                          {option.displayLabel}
                        </span>
                        {option.recommended ? (
                          <span className="rounded-full bg-[color:var(--color-chat-chip-bg)] px-2 py-0.5 text-caption font-medium text-[color:var(--color-chat-message-text)]">
                            推荐
                          </span>
                        ) : null}
                      </span>

                      {option.description ? (
                        <span className="mt-1 block text-label leading-[1.5] text-[color:var(--color-chat-muted-text)]">
                          {option.description}
                        </span>
                      ) : null}

                      {isSelected && option.preview ? (
                        <PreviewTimeline preview={option.preview} />
                      ) : null}
                    </span>
                  </button>
                )
              })}
            </div>

            {showOtherInput ? (
              <div className="mt-3 border-t border-[color:var(--color-chat-inline-border)] pt-3">
                <div className="block text-caption font-medium text-[color:var(--color-chat-muted-text)]">
                  其他补充
                </div>
                <textarea
                  aria-label="其他补充"
                  className="mt-2 min-h-[72px] w-full resize-none rounded-lg border border-[color:var(--color-chat-inline-border)] bg-[color:var(--color-chat-inline-bg)] px-3 py-2 text-body-sm leading-[1.5] text-[color:var(--color-chat-message-text)] placeholder:text-[color:var(--color-chat-muted-text)] focus:border-[color:var(--color-chat-focus-ring)]"
                  placeholder="输入自定义说明，例如镜头节奏、画幅要求或额外创作偏好"
                  value={activeDraft.otherText ?? ''}
                  onChange={(event) => {
                    updateDraft(activeQuestionKey, (current) => ({
                      ...current,
                      otherText: event.target.value,
                      useOther: true,
                      values: activeQuestion.multiSelect ? current.values : [],
                    }))
                  }}
                  onFocus={() => {
                    if (!activeDraft.useOther) {
                      updateDraft(activeQuestionKey, (current) => ({
                        ...current,
                        useOther: true,
                        values: activeQuestion.multiSelect ? current.values : [],
                      }))
                    }
                  }}
                />
              </div>
            ) : null}
          </section>
        </div>

        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-[color:var(--color-chat-inline-border)] bg-[color:var(--color-chat-card-bg)] px-4 pt-2.5 pb-3">
          <button
            type="button"
            className={cn(
              'inline-flex h-9 items-center justify-center rounded-full px-3 text-label transition-colors',
              currentIndex === 0
                ? 'pointer-events-none text-[color:var(--color-chat-muted-text)] opacity-40'
                : 'text-[color:var(--color-chat-message-text)] hover:bg-[color:var(--color-chat-tool-bg)]',
            )}
            disabled={currentIndex === 0}
            onClick={() => moveToQuestion(currentIndex - 1)}
          >
            上一步
          </button>

          <div className="flex min-w-0 items-center gap-2">
            <div className="hidden text-caption text-[color:var(--color-chat-muted-text)] sm:block">
              已完成 {completedCount} / {questions.length}
            </div>

            {currentIndex === questions.length - 1 ? (
              <button
                type="button"
                className={cn(
                  'inline-flex h-9 items-center justify-center rounded-full px-4 text-body-sm font-medium transition-all',
                  allCompleted && !isSubmitting && !isInteractionLocked
                    ? 'bg-[color:var(--color-chat-agent-rail)] text-[color:var(--color-chat-card-bg)] hover:scale-[1.03] active:scale-[0.97]'
                    : 'bg-[color:var(--color-chat-tool-bg)] text-[color:var(--color-chat-muted-text)]',
                )}
                disabled={!allCompleted || isSubmitting || isInteractionLocked}
                onClick={() => void handleSubmit()}
              >
                {isHandingOffAsk
                  ? '正在提交'
                  : isContinuationStreamActive
                    ? '生成中'
                    : '提交并继续'}
              </button>
            ) : (
              <button
                type="button"
                className={cn(
                  'inline-flex h-9 items-center justify-center rounded-full px-4 text-body-sm font-medium transition-all',
                  canGoNext
                    ? 'bg-[color:var(--color-chat-agent-rail)] text-[color:var(--color-chat-card-bg)] hover:scale-[1.03] active:scale-[0.97]'
                    : 'bg-[color:var(--color-chat-tool-bg)] text-[color:var(--color-chat-muted-text)]',
                )}
                disabled={!canGoNext}
                onClick={() => moveToQuestion(currentIndex + 1)}
              >
                下一步
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * 渲染选项附带的结构预览。
 *
 * @param props - 结构预览属性。
 * @param props.preview - 后端返回的预览文本。
 * @returns 分段后的结构预览元素。
 */
function PreviewTimeline({ preview }: { preview: string }) {
  const segments = preview
    .replace(/^结构[:：]\s*/u, '')
    .split('→')
    .map((segment) => normalizeAskUserQuestionText(segment))
    .filter(Boolean)

  if (segments.length === 0) {
    return (
      <div className="mt-3 border-l border-[color:var(--color-chat-inline-border)] pl-3 text-caption leading-[1.5] text-[color:var(--color-chat-muted-text)]">
        {preview}
      </div>
    )
  }

  return (
    <div className="mt-3 border-l border-[color:var(--color-chat-inline-border)] pl-3">
      <div className="mb-2 text-caption font-medium text-[color:var(--color-chat-muted-text)]">
        结构预览
      </div>
      <div className="flex flex-wrap gap-1.5">
        {segments.map((segment) => (
          <span
            key={segment}
            className="rounded-full bg-[color:var(--color-chat-chip-bg)] px-2.5 py-1 text-caption text-[color:var(--color-chat-message-text)]"
          >
            {segment}
          </span>
        ))}
      </div>
    </div>
  )
}

/**
 * 渲染多选项的选中图标。
 *
 * @returns 勾选图标。
 */
function CheckIcon() {
  return (
    <svg aria-hidden="true" width="10" height="10" viewBox="0 0 256 256" fill="currentColor">
      <title>已选中</title>
      <path d="M229.66,77.66l-128,128a8,8,0,0,1-11.32,0l-56-56a8,8,0,0,1,11.32-11.32L96,188.69,218.34,66.34a8,8,0,0,1,11.32,11.32Z" />
    </svg>
  )
}

/**
 * 渲染单选项的选中图标。
 *
 * @returns 圆点图标。
 */
function RadioDotIcon() {
  return (
    <svg aria-hidden="true" width="8" height="8" viewBox="0 0 8 8" fill="currentColor">
      <title>单选项已选中</title>
      <circle cx="4" cy="4" r="4" />
    </svg>
  )
}
