import {
  useAui,
  useAuiState,
  type CreateAppendMessage,
  type ToolCallMessagePart,
} from '@assistant-ui/react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate, useRouter } from '@tanstack/react-router'
import {
  ArrowLeft,
  CircleCheck,
  CircleStop,
  Clock3,
  FlaskConical,
  Image as ImageIcon,
  LoaderCircle,
  Play,
  RefreshCw,
  TriangleAlert,
  Video,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import {
  ProjectConversationTimeline,
  projectConversationTimelineItemsFromAssistantMessages,
} from '@/features/chat'
import { createConversation } from '@/features/conversations'
import {
  listVideoTaskSnapshot,
  VIDEO_TASKS_QUERY_KEY,
  type VideoTask,
  type VideoTaskAsset,
} from '@/features/tasks'
import { createStoryboardCreativeInputFromTask } from '@/features/storyboards/data/storyboard-workspace'
import {
  createStoryboardAgentSubmission,
  createStoryboardBriefPrompt,
} from '@/features/storyboards/runtime/storyboard-agent-submission'
import { StoryboardAssistantProvider } from '@/features/storyboards/runtime/storyboard-assistant-provider'
import { useAguiConnection } from '@/shared/agui/provider'
import { STORYBOARD_AGENT } from '@/shared/config/agui-target'
import { cn } from '@/shared/lib/utils'
import {
  InlineMediaThumbnail,
  MediaPreviewDialog,
  useMediaPreview,
  type MediaPreviewItem,
} from '@/shared/ui/media'
import DebugToolResultImages from './debug-tool-result-images'
import GenerateShotFramesToolDetails from './generate-shot-frames-tool-details'

/** 对话标题的后端上限。 */
const MAX_CONVERSATION_TITLE_CHARS = 200

const DEBUG_INPUT_CLASS =
  'rounded-lg border border-[var(--color-outline)] bg-[var(--color-surface-container-lowest)] text-body text-[var(--color-on-surface)] transition-colors duration-[var(--dur-s)] hover:border-[var(--color-primary)] disabled:cursor-not-allowed disabled:bg-[var(--color-disabled-container)] disabled:text-[var(--color-disabled-text)]'
const DEBUG_PANEL_CLASS =
  'overflow-hidden rounded-lg border border-[var(--color-outline-variant)] bg-[var(--color-surface-container-lowest)]'
const DEBUG_SECONDARY_BUTTON_CLASS =
  'hit-48 relative inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-md border border-[var(--color-outline-variant)] bg-[var(--color-surface-container-lowest)] px-4 text-body font-semibold text-[var(--color-on-surface)] transition duration-[var(--dur-s)] ease-[var(--ease)] hover:border-[var(--color-outline)] hover:bg-[var(--color-state-hover)] active:scale-95 disabled:cursor-not-allowed disabled:bg-[var(--color-disabled-container)] disabled:text-[var(--color-disabled-text)]'
const DEBUG_PRIMARY_BUTTON_CLASS =
  'hit-48 relative inline-flex h-12 w-full cursor-pointer items-center justify-center gap-2 rounded-md bg-[var(--color-primary)] px-5 text-body font-semibold text-[var(--color-on-primary)] shadow-[var(--shadow-1)] transition duration-[var(--dur-s)] ease-[var(--ease)] hover:-translate-y-0.5 hover:bg-[var(--color-primary-hover)] hover:shadow-[var(--shadow-2)] active:translate-y-0 active:scale-95 disabled:cursor-not-allowed disabled:bg-[var(--color-disabled-container)] disabled:text-[var(--color-disabled-text)] disabled:shadow-none sm:h-10'

type DebugRun = {
  conversationId: string
  submission: CreateAppendMessage | null
}

const debugValueText = (value: unknown) =>
  typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? String(value))

/** 在时间线对应工具事件内展示 assistant-ui 已规整的完整参数与结果。 */
function DebugToolCallDetails({ toolCall }: { toolCall: ToolCallMessagePart }) {
  if (toolCall.toolName === 'generate_shot_frames') {
    return <GenerateShotFramesToolDetails toolCall={toolCall} />
  }

  const hasResult = toolCall.result !== undefined

  return (
    <section
      aria-label={`${toolCall.toolName} 调用详情`}
      className="space-y-3 rounded-md bg-[var(--color-surface-container-low)] p-3"
      role="region"
    >
      <p className="font-mono text-caption font-semibold text-[var(--color-on-surface)]">
        {toolCall.toolName}
      </p>
      <div className="min-w-0">
        <p className="mb-1 text-label text-[var(--color-on-surface-variant)]">输入</p>
        <pre
          aria-label={`${toolCall.toolName} 输入`}
          className="thin-scrollbar overflow-x-auto font-mono text-caption break-words whitespace-pre-wrap text-[var(--color-on-surface)]"
          tabIndex={0}
        >
          {toolCall.argsText || debugValueText(toolCall.args)}
        </pre>
      </div>
      <div className="min-w-0 border-t border-[var(--color-outline-variant)] pt-3">
        <p className="mb-1 text-label text-[var(--color-on-surface-variant)]">结果</p>
        <pre
          aria-label={`${toolCall.toolName} 结果`}
          className="thin-scrollbar overflow-x-auto font-mono text-caption break-words whitespace-pre-wrap text-[var(--color-on-surface)]"
          tabIndex={0}
        >
          {hasResult ? debugValueText(toolCall.result) : '等待工具返回'}
        </pre>
        {hasResult ? (
          <DebugToolResultImages result={toolCall.result} toolName={toolCall.toolName} />
        ) : null}
      </div>
    </section>
  )
}

type DebugReferenceAsset = {
  asset: VideoTaskAsset
  label: string
}

/** 把 Task 引用的素材收敛成调试摘要需要的展示项。 */
const createDebugReferenceAssets = (
  task: VideoTask,
  assetsById: Record<string, VideoTaskAsset>,
): DebugReferenceAsset[] => [
  ...task.brief.referenceImages.flatMap((assetId, index) => {
    const asset = assetsById[assetId]
    return asset ? [{ asset, label: `参考图 ${index + 1}` }] : []
  }),
  ...task.brief.referenceVideos.flatMap((assetId, index) => {
    const asset = assetsById[assetId]
    return asset ? [{ asset, label: `参考视频 ${index + 1}` }] : []
  }),
]

/** 展示真实提交前的 Task Brief 与随消息发送的参考素材。 */
function DebugTaskInput({
  assetsById,
  task,
}: {
  assetsById: Record<string, VideoTaskAsset>
  task: VideoTask
}) {
  const referenceAssets = createDebugReferenceAssets(task, assetsById)
  const { closePreview, openPreview, preview } = useMediaPreview()

  const createPreviewItem = ({ asset, label }: DebugReferenceAsset): MediaPreviewItem => ({
    attachmentId: asset.id,
    altText: label,
    fileName: label,
    mediaType: asset.assetType,
    url: asset.url,
  })

  return (
    <section aria-labelledby="debug-input-title" className={DEBUG_PANEL_CLASS}>
      <div className="flex items-center gap-4 border-b border-[var(--color-outline-variant)] bg-[var(--color-surface-container-low)] px-4 py-4 sm:px-5">
        {task.style.previewImageUrl.trim() ? (
          <img
            alt={`${task.style.styleNo} 商品图`}
            className="size-16 shrink-0 rounded-md border border-[var(--color-outline-variant)] bg-[var(--color-surface-container)] object-cover sm:size-20"
            src={task.style.previewImageUrl}
          />
        ) : null}
        <div className="min-w-0">
          <p className="mb-1 text-label font-semibold tracking-widest text-[var(--color-primary)]">
            来源 TASK
          </p>
          <h2
            className="truncate text-title-lg font-semibold text-[var(--color-on-surface)]"
            id="debug-input-title"
          >
            {task.title}
          </h2>
          <p className="mt-1 text-body-sm text-[var(--color-on-surface-variant)]">
            款号 {task.style.styleNo} · Brief 与参考素材将按正式页提交结构发送
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-5 p-4 sm:p-5">
        <div aria-label="任务参数" className="flex flex-wrap gap-2">
          <span className="inline-flex h-8 items-center gap-1.5 rounded-full bg-[var(--color-surface-container)] px-3 text-body-sm font-medium text-[var(--color-on-surface)]">
            <span aria-hidden="true" className="font-mono text-label text-[var(--color-primary)]">
              AR
            </span>
            {task.brief.ratio?.trim() || '未填写'}
          </span>
          <span className="inline-flex h-8 items-center gap-1.5 rounded-full bg-[var(--color-surface-container)] px-3 text-body-sm font-medium text-[var(--color-on-surface)]">
            <Clock3 aria-hidden="true" size={14} strokeWidth={1.8} />
            {task.brief.durationSeconds ? `${task.brief.durationSeconds} 秒` : '时长未填写'}
          </span>
          <span className="inline-flex h-8 items-center gap-1.5 rounded-full bg-[var(--color-surface-container)] px-3 text-body-sm font-medium text-[var(--color-on-surface)]">
            <ImageIcon aria-hidden="true" size={14} strokeWidth={1.8} />
            {task.brief.referenceImages.length} 张参考图
          </span>
          <span className="inline-flex h-8 items-center gap-1.5 rounded-full bg-[var(--color-surface-container)] px-3 text-body-sm font-medium text-[var(--color-on-surface)]">
            <Video aria-hidden="true" size={14} strokeWidth={1.8} />
            {task.brief.referenceVideos.length} 个参考视频
          </span>
        </div>

        <section aria-labelledby="debug-requirement-title">
          <div className="mb-2 flex items-center justify-between gap-3">
            <h3
              className="text-body-sm font-semibold text-[var(--color-on-surface)]"
              id="debug-requirement-title"
            >
              需求描述
            </h3>
            <span className="text-label text-[var(--color-on-surface-variant)]">原样透传</span>
          </div>
          <p className="max-h-40 overflow-y-auto rounded-md border-l-4 border-[var(--color-primary)] bg-[var(--color-surface-container-low)] p-4 text-body leading-relaxed whitespace-pre-wrap text-[var(--color-on-surface)] sm:max-h-64">
            {task.brief.requirementDescription?.trim() || '（需求描述未填写）'}
          </p>
        </section>

        {referenceAssets.length > 0 ? (
          <section aria-labelledby="debug-references-title">
            <div className="mb-2 flex items-center justify-between gap-3">
              <h3
                className="text-body-sm font-semibold text-[var(--color-on-surface)]"
                id="debug-references-title"
              >
                随消息发送的素材
              </h3>
              <span className="text-label text-[var(--color-on-surface-variant)]">
                共 {referenceAssets.length} 项
              </span>
            </div>
            <ul className="flex gap-2 overflow-x-auto pb-1">
              {referenceAssets.map(({ asset, label }) => (
                <li
                  className="shrink-0 overflow-hidden rounded-sm border border-[var(--color-outline-variant)] bg-[var(--color-surface-container)]"
                  key={asset.id}
                >
                  <button
                    aria-label={`查看${label}`}
                    className="group relative block cursor-zoom-in transition duration-[var(--dur-s)] ease-[var(--ease)] hover:scale-105"
                    onClick={() => openPreview(createPreviewItem({ asset, label }))}
                    title={`查看${label}`}
                    type="button"
                  >
                    <InlineMediaThumbnail
                      className="block size-14"
                      fileName={label}
                      mediaType={asset.assetType}
                      url={asset.url}
                    />
                    <span className="pointer-events-none absolute inset-x-0 bottom-0 bg-[color:color-mix(in_srgb,var(--color-inverse-surface)_78%,transparent)] px-1 py-0.5 text-center text-caption font-medium text-[var(--color-inverse-on-surface)] opacity-0 transition-opacity duration-[var(--dur-s)] group-hover:opacity-100">
                      {asset.assetType === 'video' ? '播放' : '查看'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
      {preview ? <MediaPreviewDialog preview={preview} onClose={closePreview} /> : null}
    </section>
  )
}

/**
 * 在已挂载的 AG-UI runtime 内自动提交 Brief 并展示标准对话事件流。
 *
 * 注水完成后只追加一次首条 user 消息（startRun 即发起真实 run），
 * 之后复用项目对话的 timeline 投影与渲染；本页不维护第二套 AG-UI 解释器。
 */
function StoryboardDebugRun({
  conversationId,
  runtimeErrorMessage,
  submission,
}: {
  conversationId: string
  runtimeErrorMessage: string
  submission: CreateAppendMessage | null
}) {
  const aui = useAui()
  const messages = useAuiState((state) => state.thread.messages)
  const isRunning = useAuiState((state) => state.thread.isRunning)
  const isLoading = useAuiState((state) => state.thread.isLoading)
  const { historyLoaded } = useAguiConnection()
  const appendedRef = useRef(false)
  const [startedAtMs, setStartedAtMs] = useState<null | number>(null)
  const [nowMs, setNowMs] = useState(() => Date.now())

  useEffect(() => {
    if (!submission || appendedRef.current || !historyLoaded || isLoading || isRunning) return
    appendedRef.current = true
    setStartedAtMs(Date.now())
    aui.thread().append(submission)
  }, [aui, historyLoaded, isLoading, isRunning, submission])

  useEffect(() => {
    if (!isRunning) return
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [isRunning])

  const lastAssistant = messages.findLast((message) => message.role === 'assistant')
  const runCancelled =
    lastAssistant?.status?.type === 'incomplete' && lastAssistant.status.reason === 'cancelled'
  const messageFailure =
    lastAssistant?.status?.type === 'incomplete' && !runCancelled
      ? typeof lastAssistant.status.error === 'string' && lastAssistant.status.error.trim()
        ? lastAssistant.status.error
        : '运行失败。'
      : null
  const failureMessage = runtimeErrorMessage || messageFailure
  const runFinished = lastAssistant?.status?.type === 'complete' && !failureMessage
  const elapsedSeconds = startedAtMs ? Math.max(0, Math.round((nowMs - startedAtMs) / 1_000)) : 0
  const timelineItems = useMemo(
    () =>
      projectConversationTimelineItemsFromAssistantMessages({
        activeInterrupt: null,
        isRunning,
        messages,
      }),
    [isRunning, messages],
  )
  const toolCallsById = useMemo(() => {
    const toolCalls = new Map<string, ToolCallMessagePart>()

    for (const message of messages) {
      if (message.role !== 'assistant') continue

      for (const part of message.content) {
        if (part.type === 'tool-call') toolCalls.set(part.toolCallId, part)
      }
    }

    return toolCalls
  }, [messages])
  const renderToolDetails = useCallback(
    (toolCallId: string) => {
      const toolCall = toolCallsById.get(toolCallId)
      return toolCall ? <DebugToolCallDetails toolCall={toolCall} /> : null
    },
    [toolCallsById],
  )

  let statusText = '正在准备会话'
  if (isRunning) {
    statusText = '模型运行中'
  } else if (failureMessage) {
    statusText = '运行失败'
  } else if (runCancelled) {
    statusText = '已停止'
  } else if (runFinished) {
    statusText = '运行完成'
  } else if (appendedRef.current) {
    statusText = '已提交，等待响应'
  }

  const StatusIcon = failureMessage
    ? TriangleAlert
    : runCancelled
      ? CircleStop
      : runFinished
        ? CircleCheck
        : LoaderCircle
  const waiting = !failureMessage && !runCancelled && !runFinished

  return (
    <section aria-label="运行过程" className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden">
      <header
        className={cn(DEBUG_PANEL_CLASS, 'flex shrink-0 flex-col gap-4 p-4 sm:flex-row sm:p-5')}
      >
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <span
            className={cn(
              'grid size-10 shrink-0 place-items-center rounded-md',
              failureMessage
                ? 'bg-[var(--color-error-container)] text-[var(--color-on-error-container)]'
                : runCancelled
                  ? 'bg-[var(--color-surface-container)] text-[var(--color-on-surface-variant)]'
                  : runFinished
                    ? 'bg-[var(--color-secondary-container)] text-[var(--color-on-secondary-container)]'
                    : 'bg-[var(--color-warning-container)] text-[var(--color-on-warning-container)]',
            )}
          >
            <StatusIcon
              aria-hidden="true"
              className={waiting ? 'animate-spin' : undefined}
              size={19}
              strokeWidth={2}
            />
          </span>
          <div className="min-w-0">
            <p className="text-title font-semibold text-[var(--color-on-surface)]" role="status">
              {statusText}
            </p>
            <p className="mt-0.5 text-body-sm text-[var(--color-on-surface-variant)]">
              {isRunning ? <span aria-hidden="true">已运行 {elapsedSeconds}s · </span> : null}
              事件与模型输出会在下方实时出现
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3 rounded-md bg-[var(--color-surface-container-low)] px-3 py-2 sm:max-w-72">
          <span className="text-label text-[var(--color-on-surface-variant)]">对话</span>
          <code
            className="truncate font-mono text-body-sm font-semibold text-[var(--color-on-surface)]"
            title={conversationId}
          >
            {conversationId.slice(0, 12)}
          </code>
        </div>
      </header>

      {failureMessage ? (
        <div
          className="flex items-start gap-3 rounded-md bg-[var(--color-error-container)] p-4 text-body-sm text-[var(--color-on-error-container)]"
          role="alert"
        >
          <TriangleAlert aria-hidden="true" className="mt-0.5 shrink-0" size={17} />
          <p className="whitespace-pre-wrap">{failureMessage}</p>
        </div>
      ) : null}

      <section
        aria-label="Agent 输出"
        className={cn(DEBUG_PANEL_CLASS, 'flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden')}
      >
        {timelineItems.length === 0 ? (
          <div className="grid min-h-0 flex-1 place-items-center border border-dashed border-[var(--color-outline-variant)] bg-[var(--color-surface-container-low)] p-6 text-center">
            <div className="flex max-w-sm flex-col items-center">
              {failureMessage ? (
                <TriangleAlert
                  aria-hidden="true"
                  className="mb-3 text-[var(--color-error)]"
                  size={24}
                />
              ) : (
                <LoaderCircle
                  aria-hidden="true"
                  className="mb-3 animate-spin text-[var(--color-primary)]"
                  size={24}
                />
              )}
              <p className="text-body font-semibold text-[var(--color-on-surface)]">
                {failureMessage ? '本次运行没有可显示输出' : '等待第一条运行事件'}
              </p>
              <p className="mt-1 text-body-sm text-[var(--color-on-surface-variant)]">
                {failureMessage
                  ? '失败原因已在上方显示，可以返回运行配置后重试。'
                  : '历史加载完成后将自动提交 Brief，无需再次操作。'}
              </p>
            </div>
          </div>
        ) : (
          <ProjectConversationTimeline
            activeInterrupt={null}
            renderToolDetails={renderToolDetails}
            timelineItems={timelineItems}
            title="Agent 输出"
          />
        )}
      </section>
    </section>
  )
}

/**
 * Storyboard Agent 独立调试页：提交 Brief 即发起一次真实 run。
 *
 * 由任务确认列表的调试入口携带 taskId 进入时，取该 Task Brief 的三字段
 * 拼成 prompt，参考图 / 参考视频作为媒体随消息发送（与正式页提交同构）；
 * 直接访问时退回手动输入三字段。每次提交都开一段新的 storyboard 对话，不在旧对话上
 * 续聊——只用于观察单次运行的完整过程。
 *
 * @param props - 调试页属性。
 * @param props.conversationId - 刷新后从 URL 带回来的对话 id；有它就直接读历史。
 * @param props.taskId - 入口携带的来源 Task id；缺省即手动输入模式。
 * @returns Storyboard 调试页面。
 */
export default function StoryboardDebugRoute({
  conversationId: restoredConversationId,
  taskId,
}: {
  conversationId?: string
  taskId?: string
}) {
  const navigate = useNavigate()
  const router = useRouter()
  const [requirementDescription, setRequirementDescription] = useState('')
  const [ratio, setRatio] = useState('16:9')
  const [durationSeconds, setDurationSeconds] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [run, setRun] = useState<DebugRun | null>(() =>
    restoredConversationId ? { conversationId: restoredConversationId, submission: null } : null,
  )
  const [runningConversationId, setRunningConversationId] = useState<string | null>(null)

  const taskLibraryQuery = useQuery({
    enabled: Boolean(taskId) && !run,
    queryFn: listVideoTaskSnapshot,
    queryKey: VIDEO_TASKS_QUERY_KEY,
  })
  const selectedTask = taskId
    ? taskLibraryQuery.data?.tasks.find((task) => task.id === taskId)
    : undefined
  const taskMissing = Boolean(taskId) && taskLibraryQuery.isSuccess && !selectedTask
  const taskQueryError = taskLibraryQuery.isError
    ? taskLibraryQuery.error instanceof Error
      ? taskLibraryQuery.error.message
      : '加载来源 Task 失败。'
    : null
  const descriptionInvalid = errorMessage === '请先填写需求描述。'

  useEffect(() => {
    document.title = 'storyboard 调试 | Producer'
    return () => {
      document.title = 'Producer'
    }
  }, [])

  const handleRunningChange = useCallback((conversationId: string, running: boolean) => {
    if (running) setErrorMessage('')
    setRunningConversationId((current) => {
      if (running) return conversationId
      return current === conversationId ? null : current
    })
  }, [])
  const handleRuntimeError = useCallback((error: Error) => {
    setErrorMessage(error.message || 'Storyboard Agent 运行失败。')
    setRunningConversationId(null)
  }, [])
  const handleBack = useCallback(() => {
    if (router.history.canGoBack()) {
      router.history.back()
      return
    }

    void navigate({ to: '/' })
  }, [navigate, router])

  /**
   * 构造首条提交消息：Task 入口与正式页同构（三字段 prompt + 参考素材
   * 媒体 part），手动模式为纯文本 prompt。
   *
   * @returns 可直接 append 的消息；输入不完整时返回 null 并提示。
   */
  const createSubmission = (): CreateAppendMessage | null => {
    if (taskId) {
      const snapshot = taskLibraryQuery.data
      if (!snapshot || !selectedTask) {
        setErrorMessage(taskMissing ? `来源 Task 不存在：${taskId}` : '任务信息尚未加载完成。')
        return null
      }
      return createStoryboardAgentSubmission({
        creativeInput: createStoryboardCreativeInputFromTask(selectedTask, snapshot.assetsById),
      })
    }

    const description = requirementDescription.trim()
    if (!description) {
      setErrorMessage('请先填写需求描述。')
      return null
    }
    const parsedDuration = Number.parseInt(durationSeconds, 10)
    return {
      attachments: [],
      content: [
        {
          text: createStoryboardBriefPrompt({
            durationSeconds: Number.isNaN(parsedDuration) ? undefined : parsedDuration,
            ratio: ratio.trim() || undefined,
            requirementDescription: description,
          }),
          type: 'text',
        },
      ],
      createdAt: new Date(),
      parentId: null,
      role: 'user',
      sourceId: null,
      startRun: true,
    }
  }

  const submitBrief = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (submitting) return

    setErrorMessage('')
    setSubmitting(true)
    try {
      const submission = createSubmission()
      if (!submission) return

      // 每次提交开一段新对话：调试页只看单次运行，不在旧对话上续聊。带上 taskId，后端就
      // 知道这段对话是为哪张单开的（之后按单列尝试能找到它）。
      const conversation = await createConversation({
        agentId: STORYBOARD_AGENT.id,
        taskId,
        title: `调试 · ${selectedTask?.title ?? '手动 Brief'}`.slice(
          0,
          MAX_CONVERSATION_TITLE_CHARS,
        ),
      })
      setRun({ conversationId: conversation.id, submission })
      void navigate({
        replace: true,
        search: { conversationId: conversation.id, taskId },
        to: '/storyboard-debug',
      })
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '创建对话失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main
      className={cn(
        'h-dvh bg-[var(--color-surface)] text-[var(--color-on-surface)]',
        run ? 'overflow-hidden' : 'overflow-y-auto',
      )}
    >
      <div
        className={cn(
          'mx-auto flex w-full flex-col px-4 sm:px-6 md:px-8',
          run
            ? 'h-full max-w-screen-2xl gap-4 py-4 sm:py-5'
            : 'min-h-full max-w-6xl gap-5 py-5 sm:py-7',
        )}
      >
        <header className="flex shrink-0 flex-col gap-4 border-b border-[var(--color-outline-variant)] pb-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-start gap-3 sm:items-center">
            <button
              aria-label="返回上一页"
              className="hit-48 relative grid size-10 shrink-0 cursor-pointer place-items-center rounded-full border border-[var(--color-outline-variant)] bg-[var(--color-surface-container-lowest)] text-[var(--color-on-surface)] transition duration-[var(--dur-s)] ease-[var(--ease)] hover:-translate-x-0.5 hover:border-[var(--color-outline)] hover:bg-[var(--color-state-hover)] active:translate-x-0 active:scale-95"
              onClick={handleBack}
              title="返回上一页"
              type="button"
            >
              <ArrowLeft aria-hidden="true" size={18} strokeWidth={2} />
            </button>
            <span className="hidden size-11 shrink-0 place-items-center rounded-lg bg-[var(--color-primary-container)] text-[var(--color-on-primary-container)] sm:grid">
              <FlaskConical aria-hidden="true" size={22} strokeWidth={1.9} />
            </span>
            <div className="min-w-0">
              <p className="mb-1 flex items-center gap-2 text-label font-semibold tracking-widest text-[var(--color-primary)]">
                AGENT LAB
                <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--color-warning-container)] px-2 py-0.5 tracking-normal text-[var(--color-on-warning-container)]">
                  <span
                    aria-hidden="true"
                    className="size-1.5 rounded-full bg-[var(--color-warning)]"
                  />
                  真实环境
                </span>
              </p>
              <h1 className="text-headline font-semibold tracking-tight">Storyboard Agent 调试</h1>
              <p className="mt-1 max-w-2xl text-body-sm text-[var(--color-on-surface-variant)]">
                核对发送给 Agent 的 Brief 与参考素材，并观察单次运行的完整事件流。
              </p>
            </div>
          </div>

          {run ? (
            <button
              className={DEBUG_SECONDARY_BUTTON_CLASS}
              disabled={runningConversationId === run.conversationId}
              onClick={() => {
                setErrorMessage('')
                setRunningConversationId(null)
                setRun(null)
                void navigate({
                  replace: true,
                  search: { taskId },
                  to: '/storyboard-debug',
                })
              }}
              title={
                runningConversationId === run.conversationId
                  ? '当前运行结束后可新建运行'
                  : '返回运行配置'
              }
              type="button"
            >
              <RefreshCw aria-hidden="true" size={16} strokeWidth={1.9} />
              新建运行
            </button>
          ) : null}
        </header>

        {errorMessage && !run ? (
          <div
            className="flex items-start gap-3 rounded-md bg-[var(--color-error-container)] p-4 text-body-sm text-[var(--color-on-error-container)]"
            id="debug-form-error"
            role="alert"
          >
            <TriangleAlert aria-hidden="true" className="mt-0.5 shrink-0" size={17} />
            <p>{errorMessage}</p>
          </div>
        ) : null}

        {run ? (
          <div className="flex min-h-0 flex-1 overflow-hidden">
            <StoryboardAssistantProvider
              conversationId={run.conversationId}
              key={run.conversationId}
              onRunningChange={handleRunningChange}
              onRuntimeError={handleRuntimeError}
              showThinking
            >
              <StoryboardDebugRun
                conversationId={run.conversationId}
                runtimeErrorMessage={errorMessage}
                submission={run.submission}
              />
            </StoryboardAssistantProvider>
          </div>
        ) : (
          <form
            className="flex flex-1 flex-col gap-4"
            onSubmit={(event) => void submitBrief(event)}
          >
            <div>
              {taskId ? (
                selectedTask && taskLibraryQuery.data ? (
                  <DebugTaskInput
                    assetsById={taskLibraryQuery.data.assetsById}
                    task={selectedTask}
                  />
                ) : taskQueryError ? (
                  <section
                    aria-labelledby="debug-task-error-title"
                    className={cn(DEBUG_PANEL_CLASS, 'p-5')}
                    role="alert"
                  >
                    <span className="mb-4 grid size-10 place-items-center rounded-md bg-[var(--color-error-container)] text-[var(--color-on-error-container)]">
                      <TriangleAlert aria-hidden="true" size={19} />
                    </span>
                    <h2
                      className="text-title font-semibold text-[var(--color-on-surface)]"
                      id="debug-task-error-title"
                    >
                      来源 Task 加载失败
                    </h2>
                    <p className="mt-1 text-body-sm text-[var(--color-on-surface-variant)]">
                      {taskQueryError}
                    </p>
                    <button
                      className={cn(DEBUG_SECONDARY_BUTTON_CLASS, 'mt-4')}
                      onClick={() => void taskLibraryQuery.refetch()}
                      type="button"
                    >
                      <RefreshCw aria-hidden="true" size={16} />
                      重新加载
                    </button>
                  </section>
                ) : taskMissing ? (
                  <section
                    aria-labelledby="debug-task-missing-title"
                    className={cn(DEBUG_PANEL_CLASS, 'p-5')}
                    role="alert"
                  >
                    <span className="mb-4 grid size-10 place-items-center rounded-md bg-[var(--color-error-container)] text-[var(--color-on-error-container)]">
                      <TriangleAlert aria-hidden="true" size={19} />
                    </span>
                    <h2
                      className="text-title font-semibold text-[var(--color-on-surface)]"
                      id="debug-task-missing-title"
                    >
                      来源 Task 不存在
                    </h2>
                    <p className="mt-1 text-body-sm break-all text-[var(--color-on-surface-variant)]">
                      {taskId}
                    </p>
                  </section>
                ) : (
                  <section
                    aria-label="正在加载来源 Task"
                    className={cn(DEBUG_PANEL_CLASS, 'grid min-h-80 place-items-center p-6')}
                    role="status"
                  >
                    <div className="flex flex-col items-center text-center">
                      <LoaderCircle
                        aria-hidden="true"
                        className="mb-3 animate-spin text-[var(--color-primary)]"
                        size={24}
                      />
                      <p className="text-body font-semibold">正在加载来源 Task</p>
                      <p className="mt-1 text-body-sm text-[var(--color-on-surface-variant)]">
                        正在整理 Brief 与参考素材…
                      </p>
                    </div>
                  </section>
                )
              ) : (
                <section aria-labelledby="debug-manual-input-title" className={DEBUG_PANEL_CLASS}>
                  <div className="border-b border-[var(--color-outline-variant)] bg-[var(--color-surface-container-low)] px-4 py-4 sm:px-5">
                    <p className="mb-1 text-label font-semibold tracking-widest text-[var(--color-primary)]">
                      手动输入
                    </p>
                    <h2 className="text-title-lg font-semibold" id="debug-manual-input-title">
                      运行 Brief
                    </h2>
                    <p className="mt-1 text-body-sm text-[var(--color-on-surface-variant)]">
                      直接访问调试页时，可在这里构造三字段 prompt。
                    </p>
                  </div>
                  <div className="flex flex-col gap-5 p-4 sm:p-5">
                    <label className="flex flex-col gap-2">
                      <span className="text-body-sm font-semibold">需求描述</span>
                      <textarea
                        aria-describedby={descriptionInvalid ? 'debug-form-error' : undefined}
                        aria-invalid={descriptionInvalid}
                        className={cn(DEBUG_INPUT_CLASS, 'min-h-64 resize-y p-3')}
                        disabled={submitting}
                        onChange={(event) => setRequirementDescription(event.target.value)}
                        placeholder="粘贴要测试的 Brief（含口播旁白等，整段透传给 Agent）"
                        value={requirementDescription}
                      />
                    </label>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <label className="flex flex-col gap-2">
                        <span className="text-body-sm font-semibold">目标画幅</span>
                        <input
                          className={cn(DEBUG_INPUT_CLASS, 'h-11 px-3')}
                          disabled={submitting}
                          onChange={(event) => setRatio(event.target.value)}
                          value={ratio}
                        />
                      </label>
                      <label className="flex flex-col gap-2">
                        <span className="text-body-sm font-semibold">目标时长（秒）</span>
                        <input
                          className={cn(DEBUG_INPUT_CLASS, 'h-11 px-3')}
                          disabled={submitting}
                          min="1"
                          onChange={(event) => setDurationSeconds(event.target.value)}
                          placeholder="可留空"
                          type="number"
                          value={durationSeconds}
                        />
                      </label>
                    </div>
                  </div>
                </section>
              )}
            </div>

            <div className="flex justify-end">
              <button
                aria-busy={submitting}
                className={cn(DEBUG_PRIMARY_BUTTON_CLASS, 'sm:w-auto sm:min-w-64')}
                disabled={submitting || (Boolean(taskId) && !selectedTask)}
                title="会调用真实模型"
                type="submit"
              >
                {submitting ? (
                  <LoaderCircle aria-hidden="true" className="animate-spin" size={17} />
                ) : (
                  <Play aria-hidden="true" fill="currentColor" size={16} />
                )}
                {submitting
                  ? '正在开对话…'
                  : taskId && !selectedTask
                    ? taskQueryError || taskMissing
                      ? 'Task 不可用'
                      : '正在加载任务…'
                    : '开始真实运行'}
              </button>
            </div>
          </form>
        )}
      </div>
    </main>
  )
}
