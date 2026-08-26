import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type SetStateAction,
} from 'react'
import { useAui, useAuiState } from '@assistant-ui/react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import {
  createConversation,
  listTaskConversations,
  MAX_CONVERSATION_TITLE_CHARS,
} from '@/features/conversations'
import { listVideoTaskSnapshot, VIDEO_TASKS_QUERY_KEY, type VideoTask } from '@/features/tasks'
import { STORYBOARD_AGENT } from '@/shared/config/agui-target'
import {
  type Storyboard,
  type StoryboardShot,
  type StoryboardWorkspace,
} from '@/features/storyboards/model/storyboard-workspace'
import {
  createStoryboardFromTask,
  createStoryboardWorkspace,
} from '@/features/storyboards/data/storyboard-workspace'
import {
  createSdhs2496wDemoWorkspace,
  type StoryboardDemoMode,
} from '@/features/storyboards/data/sdhs2496w-demo-storyboard'
import StoryboardInstructionEditor, {
  type StoryboardAnnotationReference,
  type StoryboardImageReference,
  type StoryboardInstructionInsertRequest,
  type StoryboardInstructionReference,
} from '@/features/storyboards/components/storyboard-instruction-editor'
import {
  createEmptyStoryboardInstructionDocument,
  createStoryboardInstructionSubmission,
  InvalidStoryboardInstructionReferenceError,
  MentionOnlyStoryboardInstructionError,
  STORYBOARD_INSTRUCTION_REFERENCE_NODE_NAME,
} from '@/features/storyboards/components/storyboard-instruction'
import {
  STORYBOARD_ANNOTATION_TOOL_DEFINITIONS,
  type StoryboardAnnotationTool,
} from '@/features/storyboards/components/storyboard-instruction-reference'
import StoryboardIcon, {
  type StoryboardIconName,
} from '@/features/storyboards/components/storyboard-icon'
import StoryboardBriefPanel, {
  type EditableStoryboardBrief,
} from '@/features/storyboards/components/storyboard-brief-panel'
import StoryboardTaskStack from '@/features/storyboards/components/storyboard-task-stack'
import StoryboardAgentMonitor, {
  StoryboardAgentSummary,
} from '@/features/storyboards/components/storyboard-agent-monitor'
import {
  DEFAULT_MONITOR_UI,
  useStoryboardAgentMonitor,
  type StoryboardAgentMonitorHandle,
} from '@/features/storyboards/components/use-storyboard-agent-monitor'
import { storyboardAgentRunFromThread } from '@/features/storyboards/runtime/storyboard-agent'
import { StoryboardAssistantProvider } from '@/features/storyboards/runtime/storyboard-assistant-provider'
import { createStoryboardAgentSubmission } from '@/features/storyboards/runtime/storyboard-agent-submission'
import StoryboardReferenceImageTray from '@/features/storyboards/components/storyboard-reference-image-tray'
import { useStoryboardReferenceImages } from '@/features/storyboards/components/use-storyboard-reference-images'
import emptyShotFilmFrameUrl from '@/features/storyboards/assets/generated/empty-shot-film-frame.svg?url&no-inline'
import { createComposerAttachmentReferenceId } from '@/shared/composer'
import { removeEditorReferencesFromDocument } from '@/shared/editor'

const TIMELINE_PIXELS_PER_SECOND = 60
const TIMELINE_FRAME_GAP = 4
const DEFAULT_BLANK_SHOT_DURATION_SECONDS = 3

type AnnotationTool = StoryboardAnnotationTool
type AnnotationColor = 'blue' | 'green' | 'orange' | 'red'
type DrawableAnnotationTool = Exclude<AnnotationTool, 'point'>

type AnnotationPoint = {
  x: number
  y: number
}

type AnnotationStroke = {
  color: AnnotationColor
  id: string
  points: AnnotationPoint[]
  referenceId: string
  tool: AnnotationTool
  width: number
}

type AnnotationDraft = Omit<AnnotationStroke, 'id' | 'referenceId'>

type AnnotationHistory = {
  future: AnnotationStroke[][]
  past: AnnotationStroke[][]
  present: AnnotationStroke[]
}

type ModelOption = {
  description: string
  icon: StoryboardIconName
  name: string
}

type StoryboardEditorShot = Omit<StoryboardShot, 'previewUrl'> & {
  draftState?: 'blank'
  previewUrl: string | null
}

type StoryboardEditor = Omit<Storyboard, 'shots'> & {
  shots: StoryboardEditorShot[]
}

type LocalStoryboardRevision = {
  instruction: string
  referenceImages: Array<{
    fileName: string
    mediaType: string
  }>
}

const ANNOTATION_COLORS: Array<{ color: AnnotationColor; label: string }> = [
  { color: 'red', label: '红' },
  { color: 'orange', label: '橙' },
  { color: 'blue', label: '蓝' },
  { color: 'green', label: '绿' },
]

const ANNOTATION_COLOR_TOKENS: Record<AnnotationColor, string> = {
  blue: '--color-annotation-blue',
  green: '--color-annotation-green',
  orange: '--color-annotation-orange',
  red: '--color-annotation-red',
}

const ANNOTATION_WIDTHS = [
  { icon: 'width-thin', label: '细', value: 2.5 },
  { icon: 'width-medium', label: '中', value: 5 },
  { icon: 'width-thick', label: '粗', value: 8.5 },
] as const

const DEFAULT_ANNOTATION_WIDTHS: Record<DrawableAnnotationTool, number> = {
  arrow: 2.5,
  pen: 2.5,
  rect: 5,
}

const EMPTY_ANNOTATION_HISTORY: AnnotationHistory = {
  future: [],
  past: [],
  present: [],
}

const MAX_ANNOTATION_HISTORY = 50
const MIN_ANNOTATION_DRAG_DISTANCE = 0.01

const MODEL_OPTIONS: ModelOption[] = [
  {
    description: 'Gemini 2.5 Flash Image',
    icon: 'model-nano-banana',
    name: 'Nano Banana',
  },
  {
    description: 'OpenAI · gpt-image-1',
    icon: 'model-gpt-image',
    name: 'GPT-Image-1',
  },
  {
    description: '字节跳动 · 即梦',
    icon: 'model-seedream',
    name: 'Seedream 4.0',
  },
  {
    description: 'Black Forest Labs',
    icon: 'model-flux',
    name: 'FLUX.1',
  },
  {
    description: 'Midjourney Inc.',
    icon: 'model-midjourney',
    name: 'Midjourney v7',
  },
]

/**
 * 按参考稿的 Canvas 方案绘制已提交笔迹和当前拖拽预览。
 *
 * @param canvas - 覆盖在镜头画面上的高 DPI Canvas。
 * @param annotations - 使用 0–1 归一化坐标保存的笔迹。
 * @returns 无返回值。
 */
const drawAnnotationCanvas = (
  canvas: HTMLCanvasElement,
  annotations: Array<AnnotationDraft | AnnotationStroke>,
) => {
  const bounds = canvas.getBoundingClientRect()
  if (bounds.width <= 0 || bounds.height <= 0) return

  const pixelRatio = window.devicePixelRatio || 1
  const pixelWidth = Math.round(bounds.width * pixelRatio)
  const pixelHeight = Math.round(bounds.height * pixelRatio)

  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth
    canvas.height = pixelHeight
  }

  const context = canvas.getContext('2d')
  if (!context) throw new Error('故事板标注 Canvas 无法创建 2D context')

  const styles = getComputedStyle(canvas)
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
  context.clearRect(0, 0, bounds.width, bounds.height)
  context.lineCap = 'round'
  context.lineJoin = 'round'

  for (const annotation of annotations) {
    if (annotation.tool === 'point' || annotation.points.length === 0) continue

    const firstPoint = annotation.points[0]
    if (!firstPoint) continue
    const lastPoint = annotation.points.at(-1) ?? firstPoint
    const strokeColor = styles.getPropertyValue(ANNOTATION_COLOR_TOKENS[annotation.color]).trim()
    const lineWidth = annotation.width * (bounds.width / 800)

    context.save()
    context.fillStyle = strokeColor
    context.strokeStyle = strokeColor
    context.lineWidth = lineWidth

    if (annotation.tool === 'pen') {
      context.beginPath()
      for (const [index, point] of annotation.points.entries()) {
        const x = point.x * bounds.width
        const y = point.y * bounds.height
        if (index === 0) context.moveTo(x, y)
        else context.lineTo(x, y)
      }
      context.stroke()
    }

    if (annotation.tool === 'arrow') {
      const startX = firstPoint.x * bounds.width
      const startY = firstPoint.y * bounds.height
      const endX = lastPoint.x * bounds.width
      const endY = lastPoint.y * bounds.height
      const angle = Math.atan2(endY - startY, endX - startX)
      const arrowHeadLength = Math.max(16, lineWidth * 2.6)

      context.beginPath()
      context.moveTo(startX, startY)
      context.lineTo(endX, endY)
      context.stroke()
      context.beginPath()
      context.moveTo(endX, endY)
      context.lineTo(
        endX - arrowHeadLength * Math.cos(angle - 0.45),
        endY - arrowHeadLength * Math.sin(angle - 0.45),
      )
      context.lineTo(
        endX - arrowHeadLength * Math.cos(angle + 0.45),
        endY - arrowHeadLength * Math.sin(angle + 0.45),
      )
      context.closePath()
      context.fill()
    }

    if (annotation.tool === 'rect') {
      const x = Math.min(firstPoint.x, lastPoint.x) * bounds.width
      const y = Math.min(firstPoint.y, lastPoint.y) * bounds.height
      const width = Math.abs(lastPoint.x - firstPoint.x) * bounds.width
      const height = Math.abs(lastPoint.y - firstPoint.y) * bounds.height

      context.globalAlpha = 0.16
      context.fillRect(x, y, width, height)
      context.globalAlpha = 0.85
      context.lineWidth = 1.6 * (bounds.width / 800) + 0.6
      context.strokeRect(x, y, width, height)
    }

    context.restore()
  }
}

/**
 * 把秒数格式化为参考设计使用的紧凑文案。
 *
 * @param totalSeconds - 总秒数。
 * @returns 形如 “4s” 的文案。
 */
const formatSeconds = (totalSeconds: number) => `${totalSeconds}s`

/**
 * 把秒数格式化为时间线时码。
 *
 * @param totalSeconds - 总秒数。
 * @returns 形如 “00:26” 的时码。
 */
const formatTimelineTime = (totalSeconds: number) => {
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = String(totalSeconds % 60).padStart(2, '0')
  return `${String(minutes).padStart(2, '0')}:${seconds}`
}

/**
 * 为每个项目建立独立的当前镜头状态，切换项目时保留各自进度。
 *
 * @param storyboards - 工作台项目列表。
 * @returns 项目 ID 到首镜 ID 的映射。
 */
const createInitialShotSelection = (storyboards: StoryboardEditor[]) =>
  Object.fromEntries(
    storyboards.map((storyboard) => [storyboard.conversationId, storyboard.shots[0]?.id ?? '']),
  )

/**
 * 读一张需求单的历次尝试，建立 Storyboard 工作台。
 *
 * 一次尝试就是一段对话；一次都没跑过时返回空工作台，由上层给出「开始第一次」的入口，
 * 而不是在打开页面时偷偷开一段对话。
 *
 * @param taskId - 当前需求单 id。
 * @param signal - 用于取消这两个请求的 AbortSignal。
 * @param demoMode - 演示模式（只对特定款号成立）。
 * @returns 这张需求单的工作台与它自身。
 * @throws 需求单不存在或数据读取失败时抛出错误。
 */
const loadStoryboardWorkspace = async (
  taskId: string,
  signal: AbortSignal,
  demoMode?: StoryboardDemoMode,
) => {
  const [conversations, taskSnapshot] = await Promise.all([
    listTaskConversations(taskId, { signal }),
    listVideoTaskSnapshot({ signal }),
  ])
  const task = taskSnapshot.tasks.find((item) => item.id === taskId)
  if (!task) {
    throw new Error(`需求单不存在：${taskId}`)
  }

  const workspace = createStoryboardWorkspace(task, conversations, taskSnapshot.assetsById)
  if (!demoMode || workspace.storyboards.length === 0) {
    return { task, workspace }
  }

  return { task, workspace: createSdhs2496wDemoWorkspace(workspace, task) }
}

/**
 * 渲染 Storyboard 数据加载或错误状态。
 *
 * @param props - 状态文案和可访问性角色。
 * @returns 与 Storyboard 工作台共用背景的居中状态页。
 */
const StoryboardRouteState = ({
  action,
  message,
  role,
}: {
  action?: ReactNode
  message: string
  role?: 'alert'
}) => (
  <main className="storyboards-workspace storyboards-route-state" role={role}>
    <span className="storyboards-task-stack-logo" aria-hidden="true">
      <StoryboardIcon name="brand" size={18} title="Storyboard" />
    </span>
    <p>{message}</p>
    {action}
  </main>
)

/**
 * 一张需求单的 Storyboard 工作台。
 *
 * @param props - 路由属性。
 * @param props.attemptConversationId - URL 上指定要看的那次尝试；缺省看最新的一次。
 * @param props.demoMode - 演示模式。
 * @param props.taskId - 当前需求单 id。
 * @returns 这张单的历次尝试与工作台。
 */
export default function StoryboardRoute({
  attemptConversationId,
  demoMode,
  taskId,
}: {
  attemptConversationId?: string
  demoMode?: StoryboardDemoMode
  taskId: string
}) {
  const queryClient = useQueryClient()
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState('')
  const workspaceQuery = useQuery({
    queryFn: ({ signal }) => loadStoryboardWorkspace(taskId, signal, demoMode),
    queryKey: ['storyboard-task-workspace', taskId, demoMode ?? null],
  })

  useEffect(() => {
    document.title = 'storyboard | Producer'

    return () => {
      document.title = 'Producer'
    }
  }, [])

  if (workspaceQuery.isPending) {
    return <StoryboardRouteState message="正在载入创作 Task…" />
  }
  if (workspaceQuery.isError) {
    const message =
      workspaceQuery.error instanceof Error ? workspaceQuery.error.message : '加载 Storyboard 失败'
    return <StoryboardRouteState message={message} role="alert" />
  }

  const { task, workspace } = workspaceQuery.data

  // 一次都没跑过：给个入口开第一段对话，而不是打开页面就替用户花钱跑一次。
  if (workspace.storyboards.length === 0) {
    const startFirstAttempt = async () => {
      setStarting(true)
      setStartError('')
      try {
        await createStoryboardAttempt(task)
        await queryClient.invalidateQueries({
          queryKey: ['storyboard-task-workspace', taskId],
        })
      } catch (error) {
        setStartError(error instanceof Error ? error.message : '开始运行失败')
      } finally {
        setStarting(false)
      }
    }

    return (
      <StoryboardRouteState
        action={
          <button
            className="storyboards-route-state-action"
            disabled={starting}
            onClick={() => void startFirstAttempt()}
            type="button"
          >
            {starting ? '正在开始…' : '开始第一次运行'}
          </button>
        }
        message={startError || `${task.title} 还没有跑过`}
        role={startError ? 'alert' : undefined}
      />
    )
  }

  return (
    <StoryboardWorkspace
      attemptConversationId={attemptConversationId}
      task={task}
      workspace={workspace}
    />
  )
}

/**
 * 为这张需求单开一段新的 storyboard 对话（也就是一次新的尝试）。
 *
 * @param task - 当前需求单。
 * @returns 服务端发放的对话。
 */
const createStoryboardAttempt = (task: VideoTask) =>
  createConversation({
    agentId: STORYBOARD_AGENT.id,
    taskId: task.id,
    title: task.title.slice(0, MAX_CONVERSATION_TITLE_CHARS),
  })

/**
 * 渲染与参考设计一致的故事板工作台。
 *
 * 这张需求单的每一次尝试都常驻一个独立 AG-UI runtime host：切换书签不掐断别的那次
 * 运行；跨尝试保留的编辑状态（镜头选择、标注历史、本地版本）提升到本层，切换时不丢。
 *
 * @param props - 工作台属性。
 * @param props.attemptConversationId - URL 上指定要看的那次尝试。
 * @param props.task - 当前需求单。
 * @param props.workspace - 这张单的历次尝试。
 * @returns 书签栈、单画布工作台、受控 Brief 和底部时间线。
 */
export function StoryboardWorkspace({
  attemptConversationId,
  task,
  workspace,
}: {
  attemptConversationId?: string
  task: VideoTask
  workspace: StoryboardWorkspace
}) {
  const navigate = useNavigate()
  const [storyboards, setStoryboards] = useState<StoryboardEditor[]>(() => workspace.storyboards)
  const [selectedStoryboardId, setSelectedStoryboardId] = useState(() => {
    // 默认看最新那次：刚点完「开始真实运行」进来，要看的就是刚开的那一次，不是第一次。
    const newest = workspace.storyboards.at(-1)
    if (!newest) throw new Error('Storyboard 工作台必须至少有一次尝试')
    return attemptConversationId &&
      workspace.storyboards.some(
        (storyboard) => storyboard.conversationId === attemptConversationId,
      )
      ? attemptConversationId
      : newest.conversationId
  })
  const [briefOpen, setBriefOpen] = useState(false)
  const [selectedShotIds, setSelectedShotIds] = useState(() =>
    createInitialShotSelection(workspace.storyboards),
  )
  const [annotationHistoriesByTarget, setAnnotationHistoriesByTarget] = useState<
    Record<string, AnnotationHistory>
  >({})
  const [localRevisionsByShot, setLocalRevisionsByShot] = useState<
    Record<string, LocalStoryboardRevision[]>
  >({})
  const [runningConversationIds, setRunningConversationIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  )
  const [runtimeErrorMessage, setRuntimeErrorMessage] = useState('')
  const monitor = useStoryboardAgentMonitor(runningConversationIds.has(selectedStoryboardId))

  const handleRunningChange = useCallback((conversationId: string, running: boolean) => {
    setRunningConversationIds((current) => {
      if (current.has(conversationId) === running) return current
      const next = new Set(current)
      if (running) {
        next.add(conversationId)
      } else {
        next.delete(conversationId)
      }
      return next
    })
  }, [])

  const handleRuntimeError = useCallback((error: Error) => {
    setRuntimeErrorMessage(error.message || 'Storyboard Agent 运行失败。')
  }, [])

  /**
   * 切换到另一次尝试并打开它的 Brief；重复点击当前这次则收放 Brief。
   *
   * @param storyboard - 目标尝试。
   * @returns 无返回值。
   */
  const selectStoryboard = (storyboard: StoryboardEditor) => {
    if (storyboard.conversationId === selectedStoryboardId) {
      setBriefOpen((current) => !current)
      return
    }

    setSelectedStoryboardId(storyboard.conversationId)
    // 同步进 URL：刷新、收藏、发给别人看的都是同一次尝试。
    void navigate({
      params: { taskId: task.id },
      replace: true,
      search: (current) => ({ ...current, attempt: storyboard.conversationId }),
      to: '/storyboards/$taskId',
    })
    setBriefOpen(true)
  }

  return storyboards.map((storyboard) => (
    <StoryboardAssistantProvider
      conversationId={storyboard.conversationId}
      key={storyboard.conversationId}
      onRunningChange={handleRunningChange}
      onRuntimeError={handleRuntimeError}
    >
      {storyboard.conversationId === selectedStoryboardId ? (
        <StoryboardWorkspaceContent
          annotationHistoriesByTarget={annotationHistoriesByTarget}
          briefOpen={briefOpen}
          localRevisionsByShot={localRevisionsByShot}
          monitor={monitor}
          onBriefOpenChange={setBriefOpen}
          onSelectStoryboard={selectStoryboard}
          runningConversationIds={runningConversationIds}
          runtimeErrorMessage={runtimeErrorMessage}
          task={task}
          selectedShotIds={selectedShotIds}
          selectedStoryboardId={selectedStoryboardId}
          setAnnotationHistoriesByTarget={setAnnotationHistoriesByTarget}
          setLocalRevisionsByShot={setLocalRevisionsByShot}
          setSelectedShotIds={setSelectedShotIds}
          setStoryboards={setStoryboards}
          storyboards={storyboards}
        />
      ) : null}
    </StoryboardAssistantProvider>
  ))
}

function StoryboardWorkspaceContent({
  annotationHistoriesByTarget,
  briefOpen,
  localRevisionsByShot,
  monitor,
  onBriefOpenChange,
  onSelectStoryboard,
  runningConversationIds,
  runtimeErrorMessage,
  selectedShotIds,
  selectedStoryboardId,
  setAnnotationHistoriesByTarget,
  setLocalRevisionsByShot,
  setSelectedShotIds,
  setStoryboards,
  storyboards,
  task,
}: {
  annotationHistoriesByTarget: Record<string, AnnotationHistory>
  briefOpen: boolean
  localRevisionsByShot: Record<string, LocalStoryboardRevision[]>
  monitor: StoryboardAgentMonitorHandle
  onBriefOpenChange: (open: boolean) => void
  onSelectStoryboard: (storyboard: StoryboardEditor) => void
  runningConversationIds: ReadonlySet<string>
  runtimeErrorMessage: string
  selectedShotIds: Record<string, string>
  selectedStoryboardId: string
  setAnnotationHistoriesByTarget: Dispatch<SetStateAction<Record<string, AnnotationHistory>>>
  setLocalRevisionsByShot: Dispatch<SetStateAction<Record<string, LocalStoryboardRevision[]>>>
  setSelectedShotIds: Dispatch<SetStateAction<Record<string, string>>>
  setStoryboards: Dispatch<SetStateAction<StoryboardEditor[]>>
  storyboards: StoryboardEditor[]
  task: VideoTask
}) {
  const aui = useAui()
  const agentMessages = useAuiState((state) => state.thread.messages)
  const agentIsRunning = useAuiState((state) => state.thread.isRunning)
  const [startingAttempt, setStartingAttempt] = useState(false)
  const [selectedTool, setSelectedTool] = useState<AnnotationTool>('point')
  const [selectedColor, setSelectedColor] = useState<AnnotationColor>('red')
  const [selectedModel, setSelectedModel] = useState(() => {
    const initialStoryboard =
      storyboards.find((storyboard) => storyboard.conversationId === selectedStoryboardId) ??
      storyboards[0]
    return initialStoryboard?.modelLabel ?? ''
  })
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [instructionDocument, setInstructionDocument] = useState(
    createEmptyStoryboardInstructionDocument,
  )
  const [instructionReferenceInsertRequest, setInstructionReferenceInsertRequest] =
    useState<StoryboardInstructionInsertRequest | null>(null)
  const [notice, setNotice] = useState('')
  const [compareActive, setCompareActive] = useState(false)
  const [annotationWidths, setAnnotationWidths] = useState(DEFAULT_ANNOTATION_WIDTHS)
  const annotationCanvasRef = useRef<HTMLCanvasElement>(null)
  const annotationDraftRef = useRef<AnnotationDraft | null>(null)
  const annotationReferenceId = useRef(0)
  const instructionReferenceInsertRequestId = useRef(0)
  const blankShotId = useRef(0)

  // 素材快照给「再跑一次」用：新尝试的 Brief 与参考素材从同一份快照里取。
  const taskLibraryQuery = useQuery({
    queryFn: listVideoTaskSnapshot,
    queryKey: VIDEO_TASKS_QUERY_KEY,
  })

  const selectedStoryboard =
    storyboards.find((storyboard) => storyboard.conversationId === selectedStoryboardId) ??
    storyboards[0]
  if (!selectedStoryboard) {
    throw new Error('Storyboard 工作台必须至少包含一个任务')
  }
  const selectedAgentRun = storyboardAgentRunFromThread(
    selectedStoryboard,
    agentMessages,
    agentIsRunning,
  )
  const {
    close: closeMonitor,
    dismiss: dismissSummary,
    monitorUiByConversation,
    nowMs,
    open: openRun,
    toggleExpanded: toggleMonitorExpanded,
  } = monitor
  const selectedShotId = selectedStoryboard
    ? selectedShotIds[selectedStoryboard.conversationId]
    : undefined
  const selectedShot =
    selectedStoryboard?.shots.find((shot) => shot.id === selectedShotId) ??
    selectedStoryboard?.shots[0]
  const selectedShotIndex =
    selectedStoryboard && selectedShot
      ? selectedStoryboard.shots.findIndex((shot) => shot.id === selectedShot.id)
      : -1
  const totalDuration = useMemo(
    () =>
      selectedStoryboard?.shots.reduce((duration, shot) => duration + shot.durationSeconds, 0) ?? 0,
    [selectedStoryboard],
  )
  const timelineTicks = useMemo(
    () =>
      totalDuration > 0 ? Array.from({ length: totalDuration + 1 }, (_, second) => second) : [0],
    [totalDuration],
  )
  const annotationTarget =
    selectedStoryboard && selectedShot
      ? `${selectedStoryboard.conversationId}:${selectedShot.id}`
      : ''
  const {
    clear: clearReferenceImages,
    errorMessage: referenceImageErrorMessage,
    images: referenceImages,
    ingest: ingestReferenceImages,
    pendingCount: pendingReferenceImageCount,
    remove: removeReferenceImageAttachment,
  } = useStoryboardReferenceImages(annotationTarget)
  const annotationHistory =
    annotationHistoriesByTarget[annotationTarget] ?? EMPTY_ANNOTATION_HISTORY
  const shotAnnotations = annotationHistory.present
  const annotationReferences = useMemo<StoryboardAnnotationReference[]>(() => {
    const sourcePreviewUrl = selectedShot?.previewUrl
    if (!sourcePreviewUrl) {
      if (shotAnnotations.length > 0) {
        throw new Error('含画面标注的镜头缺少来源预览图。')
      }
      return []
    }

    return shotAnnotations.map((annotation) => ({
      id: annotation.referenceId,
      kind: 'annotation',
      label: annotation.id,
      sourcePreviewUrl,
      tool: annotation.tool,
    }))
  }, [selectedShot?.previewUrl, shotAnnotations])
  const imageReferences = useMemo<StoryboardImageReference[]>(
    () =>
      referenceImages.map((image) => {
        if (image.kind !== 'image') {
          throw new Error(`Storyboard 参考图片目录收到非图片附件：${image.kind}`)
        }

        return {
          id: createComposerAttachmentReferenceId(image.id),
          kind: 'image',
          label: image.name,
          sourcePreviewUrl: image.thumbnailUrl ?? image.url,
        }
      }),
    [referenceImages],
  )
  const instructionReferences = useMemo<StoryboardInstructionReference[]>(
    () => [...imageReferences, ...annotationReferences],
    [annotationReferences, imageReferences],
  )

  /**
   * 在用户主动删除来源时同步移除指令中的稳定引用节点。
   *
   * @param referenceIds - 需要从当前指令删除的稳定引用 ID。
   * @returns 无返回值。
   */
  const removeInstructionReferences = (referenceIds: string[]) => {
    setInstructionDocument((current) =>
      removeEditorReferencesFromDocument(
        current,
        STORYBOARD_INSTRUCTION_REFERENCE_NODE_NAME,
        new Set(referenceIds),
      ),
    )
  }

  /**
   * 删除参考图片及当前指令中指向它的 Mention。
   *
   * @param attachmentId - 需要删除的参考图片附件 ID。
   * @returns 无返回值。
   */
  const removeReferenceImage = (attachmentId: string) => {
    removeInstructionReferences([createComposerAttachmentReferenceId(attachmentId)])
    removeReferenceImageAttachment(attachmentId)
    setNotice('已移除参考图片。')
  }

  useEffect(() => {
    const canvas = annotationCanvasRef.current
    if (!canvas) return

    const redraw = () => drawAnnotationCanvas(canvas, shotAnnotations)
    redraw()
    window.addEventListener('resize', redraw)

    return () => window.removeEventListener('resize', redraw)
  }, [annotationTarget, shotAnnotations])

  // 共享 runtime host 上报的运行错误经页面提示统一呈现。
  useEffect(() => {
    if (runtimeErrorMessage) setNotice(runtimeErrorMessage)
  }, [runtimeErrorMessage])

  useEffect(() => {
    if (selectedAgentRun?.phase !== 'completed') return
    setStoryboards((current) =>
      current.map((storyboard) =>
        storyboard.conversationId === selectedAgentRun.conversationId &&
        storyboard.status !== 'submitted'
          ? { ...storyboard, status: 'submitted' }
          : storyboard,
      ),
    )
  }, [selectedAgentRun?.phase, selectedAgentRun?.conversationId, setStoryboards])

  const selectedMonitorUi =
    monitorUiByConversation[selectedStoryboard.conversationId] ?? DEFAULT_MONITOR_UI
  const agentRunRecord = selectedAgentRun?.phase === 'running' ? null : selectedAgentRun

  const localRevisions = selectedShot ? (localRevisionsByShot[selectedShot.id] ?? []) : []
  const versionCount = selectedShot ? selectedShot.versions.length + localRevisions.length : 0
  const currentVersionLabel = versionCount === 0 ? '未生成' : `v${versionCount}`
  const selectedModelOption =
    MODEL_OPTIONS.find((model) => model.name === selectedModel) ?? MODEL_OPTIONS[0]
  const selectedAnnotationWidth = selectedTool === 'point' ? null : annotationWidths[selectedTool]

  /**
   * 按已提交标注和可选绘制草稿重绘画布。
   *
   * @param draft - 当前指针手势形成的临时标注；省略时读取草稿引用。
   * @returns 无返回值。
   */
  const redrawAnnotationDraft = (draft = annotationDraftRef.current) => {
    const canvas = annotationCanvasRef.current
    if (canvas) {
      drawAnnotationCanvas(canvas, draft ? [...shotAnnotations, draft] : shotAnnotations)
    }
  }

  /**
   * 取消当前绘制手势并恢复已提交标注画面。
   *
   * @returns 无返回值。
   */
  const cancelAnnotationDraft = () => {
    annotationDraftRef.current = null
    redrawAnnotationDraft(null)
  }

  /**
   * 通过统一历史入口更新当前镜头标注，并清空 redo 分支。
   *
   * @param update - 根据当前标注返回下一份不可变标注列表的函数。
   * @returns 无返回值。
   */
  const updateShotAnnotations = (
    update: (currentAnnotations: AnnotationStroke[]) => AnnotationStroke[],
  ) => {
    setAnnotationHistoriesByTarget((current) => {
      const history = current[annotationTarget] ?? EMPTY_ANNOTATION_HISTORY
      const nextAnnotations = update(history.present)
      if (nextAnnotations === history.present) return current

      return {
        ...current,
        [annotationTarget]: {
          future: [],
          past: [...history.past, history.present].slice(-MAX_ANNOTATION_HISTORY),
          present: nextAnnotations,
        },
      }
    })
  }

  /**
   * 把指针坐标转换为标注画布内的归一化坐标。
   *
   * @param event - 标注舞台上的 React 指针事件。
   * @returns 横纵轴都以 0 到 1 表示的画布坐标。
   */
  const getAnnotationPoint = (event: ReactPointerEvent<HTMLDivElement>): AnnotationPoint => {
    const bounds = event.currentTarget.getBoundingClientRect()
    return {
      x: (event.clientX - bounds.left) / bounds.width,
      y: (event.clientY - bounds.top) / bounds.height,
    }
  }

  /**
   * 为这张需求单再开一次尝试，并切过去。
   *
   * 只开对话、不发消息：跑什么内容由用户在新书签里提交，这里不替他花钱。
   *
   * @returns 无返回值。
   */
  const startAnotherAttempt = async () => {
    setStartingAttempt(true)
    setNotice('')
    try {
      const snapshot = taskLibraryQuery.data
      if (!snapshot) throw new Error('任务素材尚未加载完成')

      const conversation = await createStoryboardAttempt(task)
      const storyboard = createStoryboardFromTask(conversation, task, snapshot.assetsById)

      setStoryboards((current) => [...current, storyboard])
      setSelectedShotIds((current) => ({
        ...current,
        ...createInitialShotSelection([storyboard]),
      }))
      onSelectStoryboard(storyboard)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setStartingAttempt(false)
    }
  }

  /**
   * 切换当前项目的选中镜头。
   *
   * @param shot - 目标镜头。
   * @returns 无返回值。
   */
  const selectShot = (shot: StoryboardEditorShot) => {
    cancelAnnotationDraft()
    clearReferenceImages()
    setSelectedShotIds((current) => ({
      ...current,
      [selectedStoryboard.conversationId]: shot.id,
    }))
    setInstructionDocument(createEmptyStoryboardInstructionDocument())
    setInstructionReferenceInsertRequest(null)
    setCompareActive(false)
  }

  /**
   * 按当前镜头顺序选择相邻镜头。
   *
   * @param direction - -1 表示上一镜，1 表示下一镜。
   * @returns 无返回值。
   */
  const selectAdjacentShot = (direction: -1 | 1) => {
    const nextShot = selectedStoryboard.shots[selectedShotIndex + direction]
    if (nextShot) selectShot(nextShot)
  }

  /**
   * 在指定镜头之后插入一个本地空白镜头，并将它设为当前镜头。
   *
   * @param afterShotIndex - 插入点左侧镜头的数组下标。
   * @returns 无返回值。
   */
  const insertBlankShot = (afterShotIndex: number) => {
    const sourceShot = selectedStoryboard.shots[afterShotIndex]
    if (!sourceShot) return

    cancelAnnotationDraft()
    clearReferenceImages()
    blankShotId.current += 1
    const newShotId = `${selectedStoryboard.conversationId}-blank-${blankShotId.current}`
    const blankShot: StoryboardEditorShot = {
      aspectRatio: sourceShot.aspectRatio,
      cameraMovement: '待设置',
      description: '等待补充画面描述。',
      dialogue: '暂无对白或旁白。',
      draftState: 'blank',
      durationSeconds: DEFAULT_BLANK_SHOT_DURATION_SECONDS,
      id: newShotId,
      previewUrl: null,
      sequence: afterShotIndex + 2,
      shotSize: '待设置',
      title: '未命名镜头',
      versions: [],
    }

    setStoryboards((current) =>
      current.map((storyboard) => {
        if (storyboard.conversationId !== selectedStoryboard.conversationId) return storyboard

        const shots = [
          ...storyboard.shots.slice(0, afterShotIndex + 1),
          blankShot,
          ...storyboard.shots.slice(afterShotIndex + 1),
        ].map((shot, index) => ({ ...shot, sequence: index + 1 }))

        return { ...storyboard, shots }
      }),
    )
    setSelectedShotIds((current) => ({
      ...current,
      [selectedStoryboard.conversationId]: newShotId,
    }))
    setInstructionDocument(createEmptyStoryboardInstructionDocument())
    setInstructionReferenceInsertRequest(null)
    setCompareActive(false)
    setNotice('已插入空白分镜。')
  }

  /**
   * 开始打点或拖拽标注手势。
   *
   * @param event - 标注舞台收到的 pointerdown 事件。
   * @returns 无返回值。
   */
  const startAnnotation = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (
      !selectedShot ||
      event.button !== 0 ||
      event.isPrimary === false ||
      compareActive ||
      selectedShot.draftState === 'blank'
    ) {
      return
    }

    event.preventDefault()
    if (typeof event.currentTarget.setPointerCapture === 'function') {
      event.currentTarget.setPointerCapture(event.pointerId)
    }

    const point = getAnnotationPoint(event)
    if (selectedTool === 'point') {
      annotationReferenceId.current += 1
      const referenceId = `annotation-${annotationReferenceId.current}`
      updateShotAnnotations((current) => [
        ...current,
        {
          color: selectedColor,
          id: `M${String(current.length + 1).padStart(2, '0')}`,
          points: [point],
          referenceId,
          tool: 'point',
          width: 0,
        },
      ])
      return
    }

    annotationDraftRef.current = {
      color: selectedColor,
      points: [point],
      tool: selectedTool,
      width: annotationWidths[selectedTool],
    }
    redrawAnnotationDraft()
  }

  /**
   * 将新的归一化坐标追加到当前绘制草稿。
   *
   * @param event - 标注舞台收到的 pointermove 事件。
   * @returns 无返回值。
   */
  const moveAnnotation = (event: ReactPointerEvent<HTMLDivElement>) => {
    const draft = annotationDraftRef.current
    if (!draft) return

    draft.points.push(getAnnotationPoint(event))
    redrawAnnotationDraft(draft)
  }

  /**
   * 完成当前绘制手势并写入带稳定引用 ID 的标注。
   *
   * @param event - 标注舞台收到的 pointerup 事件。
   * @returns 无返回值。
   */
  const finishAnnotation = (event: ReactPointerEvent<HTMLDivElement>) => {
    const draft = annotationDraftRef.current
    if (!draft) return

    const completedDraft = {
      ...draft,
      points: [...draft.points, getAnnotationPoint(event)],
    }
    const start = completedDraft.points[0]
    if (!start) {
      cancelAnnotationDraft()
      return
    }
    const end = completedDraft.points.at(-1) ?? start
    const distance = Math.hypot(end.x - start.x, end.y - start.y)

    annotationDraftRef.current = null
    if (
      completedDraft.tool !== 'pen' &&
      distance < MIN_ANNOTATION_DRAG_DISTANCE &&
      completedDraft.points.length < 3
    ) {
      redrawAnnotationDraft(null)
      return
    }

    annotationReferenceId.current += 1
    const referenceId = `annotation-${annotationReferenceId.current}`
    updateShotAnnotations((current) => [
      ...current,
      {
        ...completedDraft,
        id: `M${String(current.length + 1).padStart(2, '0')}`,
        referenceId,
      },
    ])
  }

  /**
   * 处理指针取消事件，丢弃未完成标注。
   *
   * @returns 无返回值。
   */
  const cancelAnnotation = () => cancelAnnotationDraft()

  /**
   * 撤销最近一次标注变更，并删除不再存在的指令引用。
   *
   * @returns 无返回值。
   */
  const undoAnnotation = () => {
    const previousAnnotations = annotationHistory.past.at(-1)
    if (!previousAnnotations) return

    const previousReferenceIds = new Set(
      previousAnnotations.map((annotation) => annotation.referenceId),
    )
    const removedReferenceIds = shotAnnotations
      .filter((annotation) => !previousReferenceIds.has(annotation.referenceId))
      .map((annotation) => annotation.referenceId)
    if (removedReferenceIds.length > 0) removeInstructionReferences(removedReferenceIds)

    setAnnotationHistoriesByTarget((current) => {
      const history = current[annotationTarget] ?? EMPTY_ANNOTATION_HISTORY
      const previous = history.past.at(-1)
      if (!previous) return current

      return {
        ...current,
        [annotationTarget]: {
          future: [history.present, ...history.future],
          past: history.past.slice(0, -1),
          present: previous,
        },
      }
    })
  }

  /**
   * 恢复最近一次撤销的标注；已被删除的 Mention 不随标注静默复活。
   *
   * @returns 无返回值。
   */
  const redoAnnotation = () => {
    setAnnotationHistoriesByTarget((current) => {
      const history = current[annotationTarget] ?? EMPTY_ANNOTATION_HISTORY
      const next = history.future[0]
      if (!next) return current

      return {
        ...current,
        [annotationTarget]: {
          future: history.future.slice(1),
          past: [...history.past, history.present].slice(-MAX_ANNOTATION_HISTORY),
          present: next,
        },
      }
    })
  }

  /**
   * 清除当前镜头全部标注及其指令引用，并保留可撤销历史。
   *
   * @returns 无返回值。
   */
  const clearAnnotations = () => {
    if (shotAnnotations.length === 0) return
    removeInstructionReferences(shotAnnotations.map((annotation) => annotation.referenceId))
    updateShotAnnotations(() => [])
    setNotice('已清除全部标注 · 可撤销')
  }

  /**
   * 请求指令编辑器在当前选区插入指定标注引用。
   *
   * @param annotation - 需要引用的当前镜头标注。
   * @returns 无返回值。
   */
  const insertAnnotationReference = (annotation: AnnotationStroke) => {
    instructionReferenceInsertRequestId.current += 1
    setInstructionReferenceInsertRequest({
      id: annotation.referenceId,
      requestId: instructionReferenceInsertRequestId.current,
    })
    setNotice(`已引用 @${annotation.id} 到修改指令`)
  }

  /**
   * 删除单个标注及其指令引用，并重新编号剩余可见标签。
   *
   * @param annotation - 需要删除的当前镜头标注。
   * @returns 无返回值。
   */
  const deleteAnnotation = (annotation: AnnotationStroke) => {
    if (!shotAnnotations.some((candidate) => candidate.referenceId === annotation.referenceId)) {
      return
    }

    removeInstructionReferences([annotation.referenceId])
    updateShotAnnotations((current) =>
      current
        .filter((candidate) => candidate.referenceId !== annotation.referenceId)
        .map((candidate, index) => ({
          ...candidate,
          id: `M${String(index + 1).padStart(2, '0')}`,
        })),
    )
    setNotice(`已删除标注 ${annotation.id} · 可撤销`)
  }

  /**
   * 提交当前镜头的修改指令，并在原型内生成一条新版本记录。
   *
   * @returns 无返回值。
   */
  const submitRevision = () => {
    if (!selectedShot) {
      setNotice('等待 Agent 生成镜头后再提交修改。')
      return
    }
    if (pendingReferenceImageCount > 0) {
      setNotice('参考图片仍在处理中，请稍后提交。')
      return
    }

    let trimmedInstruction: string
    try {
      trimmedInstruction = createStoryboardInstructionSubmission({
        document: instructionDocument,
        references: instructionReferences,
      }).instruction
    } catch (error) {
      if (error instanceof InvalidStoryboardInstructionReferenceError) {
        setNotice('修改指令包含已失效的引用，请删除该引用后再提交。')
        return
      }
      if (error instanceof MentionOnlyStoryboardInstructionError) {
        setNotice('修改指令不能只包含引用。')
        return
      }
      throw error
    }

    if (!trimmedInstruction && shotAnnotations.length === 0 && referenceImages.length === 0) {
      setNotice('请先填写修改指令、标注画面或添加参考图片。')
      return
    }

    const revisionSources = [
      shotAnnotations.length > 0 ? `${shotAnnotations.length} 个画面标注` : '',
      referenceImages.length > 0 ? `${referenceImages.length} 张参考图片` : '',
    ].filter(Boolean)
    const submittedInstruction = trimmedInstruction || `根据 ${revisionSources.join('和 ')}重绘`
    const submittedReferenceImages = referenceImages.map((image) => ({
      fileName: image.file?.name ?? image.name,
      mediaType: image.mediaType,
    }))
    setLocalRevisionsByShot((current) => ({
      ...current,
      [selectedShot.id]: [
        {
          instruction: submittedInstruction,
          referenceImages: submittedReferenceImages,
        },
        ...(current[selectedShot.id] ?? []),
      ],
    }))
    setInstructionDocument(createEmptyStoryboardInstructionDocument())
    setInstructionReferenceInsertRequest(null)
    clearReferenceImages()
    setNotice(`${selectedShot.title} 已生成新版本`)
  }

  /**
   * 切换版本对比；只有两个以上版本时才进入对比态。
   *
   * @returns 无返回值。
   */
  const toggleComparison = () => {
    if (versionCount === 0) {
      setNotice('当前镜头尚未生成版本。')
      return
    }
    if (versionCount < 2) {
      setNotice('当前镜头只有一个版本，生成新版本后可对比。')
      return
    }
    cancelAnnotationDraft()
    setCompareActive((current) => !current)
  }

  /**
   * 确认当前创作 Brief，并记录用于界面回显的本地时间。
   *
   * @returns 无返回值。
   */
  const confirmCreativeBrief = () => {
    if (selectedStoryboard.status !== 'draft') return
    const confirmedAt = new Date().toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      hour12: false,
      minute: '2-digit',
    })
    setStoryboards((current) =>
      current.map((storyboard) =>
        storyboard.conversationId === selectedStoryboard.conversationId
          ? { ...storyboard, confirmedAt, status: 'confirmed' }
          : storyboard,
      ),
    )
    setNotice('创作 Brief 已确认，可以提交了。')
  }

  /**
   * 保存草稿 Brief 的可编辑字段；输入素材仍由独立素材流程维护。
   *
   * @param brief - 用户在左侧编辑器中确认保存的 Brief 字段。
   * @returns 无返回值。
   */
  const saveCreativeBrief = (brief: EditableStoryboardBrief) => {
    setStoryboards((current) =>
      current.map((storyboard) =>
        storyboard.conversationId === selectedStoryboard.conversationId
          ? {
              ...storyboard,
              creativeInput: {
                ...storyboard.creativeInput,
                ...brief,
              },
            }
          : storyboard,
      ),
    )
    setNotice('创作 Brief 已保存，请确认后提交。')
  }

  /**
   * 提交已确认的创作 Brief，并启动真实 Storyboard Agent 运行。
   *
   * @returns 无返回值。
   * @throws 当前 Brief 未确认时抛出错误，避免绕过产品门禁。
   */
  const submitCreativeTask = () => {
    if (selectedStoryboard.status !== 'confirmed') {
      throw new Error('只有已确认的创作 Brief 可以提交。')
    }
    setNotice('')
    aui.thread().append(createStoryboardAgentSubmission(selectedStoryboard))
    openRun(selectedStoryboard.conversationId, false)
  }

  return (
    <main className="storyboards-workspace" data-storyboard-task-id={task.id}>
      <div
        className="storyboards-body"
        onClick={(event) => {
          if (event.target === event.currentTarget) {
            onBriefOpenChange(false)
          }
        }}
      >
        <StoryboardTaskStack
          activeId={selectedStoryboard.conversationId}
          items={storyboards}
          onAdd={() => {
            if (!startingAttempt) void startAnotherAttempt()
          }}
          onSelect={onSelectStoryboard}
          runningConversationIds={runningConversationIds}
        />

        <div className="storyboards-main-grid">
          {briefOpen ? (
            <button
              aria-label="关闭创作 Brief"
              className="storyboards-brief-scrim"
              onClick={() => onBriefOpenChange(false)}
              type="button"
            />
          ) : null}

          <StoryboardBriefPanel
            agentRun={selectedAgentRun}
            onConfirm={confirmCreativeBrief}
            onOpenChange={onBriefOpenChange}
            onOpenRunRecord={() => openRun(selectedStoryboard.conversationId)}
            onSave={saveCreativeBrief}
            onSubmit={submitCreativeTask}
            open={briefOpen}
            storyboard={selectedStoryboard}
          />

          <section className="storyboards-workbench" aria-label="镜头预览舞台">
            <div className="storyboards-toolbar" aria-label="画面标注工具">
              <div className="storyboards-toolbar-editor">
                <div className="storyboards-tool-group">
                  {STORYBOARD_ANNOTATION_TOOL_DEFINITIONS.map(({ controlLabel, icon, tool }) => (
                    <button
                      key={tool}
                      type="button"
                      className="storyboards-tool-button"
                      aria-label={controlLabel}
                      aria-pressed={selectedTool === tool}
                      onClick={() => {
                        cancelAnnotationDraft()
                        setSelectedTool(tool)
                      }}
                    >
                      <StoryboardIcon name={icon} size={16.5} title={controlLabel} />
                    </button>
                  ))}
                </div>
                <div className="storyboards-tool-group storyboards-color-group">
                  {ANNOTATION_COLORS.map(({ color, label }) => (
                    <button
                      key={color}
                      type="button"
                      className="storyboards-color-swatch"
                      data-color={color}
                      aria-label={label}
                      aria-pressed={selectedColor === color}
                      onClick={() => setSelectedColor(color)}
                    />
                  ))}
                </div>
                <div className="storyboards-tool-group storyboards-width-group">
                  {ANNOTATION_WIDTHS.map(({ icon, label, value }) => (
                    <button
                      key={value}
                      type="button"
                      className="storyboards-tool-button"
                      aria-label={label}
                      aria-pressed={selectedAnnotationWidth === value}
                      disabled={selectedTool === 'point'}
                      onClick={() => {
                        if (selectedTool === 'point') return
                        setAnnotationWidths((current) => ({
                          ...current,
                          [selectedTool]: value,
                        }))
                      }}
                    >
                      <StoryboardIcon name={icon} size={16.5} title={label} />
                    </button>
                  ))}
                </div>
                <div className="storyboards-tool-group">
                  <button
                    type="button"
                    className="storyboards-tool-button"
                    aria-label="撤销"
                    disabled={annotationHistory.past.length === 0}
                    onClick={undoAnnotation}
                  >
                    <StoryboardIcon name="undo" size={16} title="撤销" />
                  </button>
                  <button
                    type="button"
                    className="storyboards-tool-button"
                    aria-label="重做"
                    disabled={annotationHistory.future.length === 0}
                    onClick={redoAnnotation}
                  >
                    <StoryboardIcon name="redo" size={16} title="重做" />
                  </button>
                  <span className="storyboards-tool-divider" aria-hidden="true" />
                  <button
                    type="button"
                    className="storyboards-tool-button"
                    aria-label="一键清除全部标注"
                    disabled={shotAnnotations.length === 0}
                    onClick={clearAnnotations}
                  >
                    <StoryboardIcon name="trash" size={16} title="清除全部标注" />
                  </button>
                </div>
              </div>
              <button
                type="button"
                className="storyboards-compare-button"
                aria-label="切换版本对比"
                aria-pressed={compareActive}
                onClick={toggleComparison}
              >
                <StoryboardIcon name="compare-split" size={14} title="版本对比" />
                版本对比
              </button>
            </div>

            <div className="storyboards-stage-zone">
              <div className="storyboards-stage-viewport">
                {selectedShot?.previewUrl ? (
                  <div
                    className="storyboards-stage-frame"
                    role="region"
                    data-annotation-tool={selectedTool}
                    data-aspect-ratio={selectedShot.aspectRatio}
                    data-comparing={compareActive || undefined}
                    aria-label={`${selectedShot.title} 镜头画面；使用所选工具可添加标注`}
                    onPointerCancel={cancelAnnotation}
                    onPointerDown={startAnnotation}
                    onPointerMove={moveAnnotation}
                    onPointerUp={finishAnnotation}
                  >
                    <img
                      src={selectedShot.previewUrl}
                      alt={`${selectedShot.title} 镜头预览`}
                      draggable={false}
                    />
                    <canvas
                      ref={annotationCanvasRef}
                      className="storyboards-annotation-canvas"
                      aria-hidden="true"
                    />
                    {compareActive ? (
                      <span className="storyboards-compare-overlay">
                        <span>上一版</span>
                        <span>当前版</span>
                      </span>
                    ) : null}
                    {versionCount > 1 ? (
                      <span className="storyboards-stage-version">{currentVersionLabel}</span>
                    ) : null}
                    <span className="storyboards-stage-duration">
                      {selectedShot.aspectRatio} · {formatSeconds(selectedShot.durationSeconds)}
                    </span>
                    {shotAnnotations.map((annotation) => {
                      const start = annotation.points[0]
                      if (!start) return null
                      const end = annotation.points.at(-1) ?? start
                      const anchor =
                        annotation.tool === 'rect'
                          ? { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y) }
                          : start
                      let arrowLabelSide: 'after' | 'before' | undefined
                      if (annotation.tool === 'arrow') {
                        arrowLabelSide = end.x >= start.x ? 'before' : 'after'
                      }

                      return (
                        <span
                          key={annotation.referenceId}
                          className="storyboards-annotation-pin"
                          data-annotation-id={annotation.id}
                          data-annotation-reference-id={annotation.referenceId}
                          data-color={annotation.color}
                          data-label-side={arrowLabelSide}
                          data-tool={annotation.tool}
                          data-width={annotation.width || undefined}
                          style={{ left: `${anchor.x * 100}%`, top: `${anchor.y * 100}%` }}
                          onPointerDown={(event) => event.stopPropagation()}
                        >
                          {annotation.tool === 'point' ? <i /> : null}
                          <span className="storyboards-annotation-pin-line" aria-hidden="true" />
                          <span className="storyboards-annotation-tag">
                            <button
                              type="button"
                              aria-label={`引用 @${annotation.id}`}
                              onClick={(event) => {
                                event.stopPropagation()
                                insertAnnotationReference(annotation)
                              }}
                            >
                              {annotation.id}
                            </button>
                            <button
                              type="button"
                              className="storyboards-annotation-delete"
                              aria-label={`删除标注 ${annotation.id}`}
                              onClick={(event) => {
                                event.stopPropagation()
                                deleteAnnotation(annotation)
                              }}
                            >
                              <StoryboardIcon name="close" size={9} title="删除标注" />
                            </button>
                          </span>
                        </span>
                      )
                    })}
                    <span className="storyboards-stage-meta">
                      <strong>
                        {selectedShot.title}
                        <small>
                          {selectedShot.shotSize} · {selectedShot.cameraMovement}
                        </small>
                      </strong>
                      <span>{selectedShot.description}</span>
                      <em>{selectedShot.dialogue}</em>
                    </span>
                  </div>
                ) : null}
              </div>
              <button
                type="button"
                className="storyboards-stage-arrow storyboards-stage-arrow-prev"
                aria-label="上一个分镜"
                disabled={!selectedShot || selectedShotIndex <= 0}
                onClick={() => selectAdjacentShot(-1)}
              >
                <StoryboardIcon name="chevron-left" size={16} title="上一个分镜" />
              </button>
              <button
                type="button"
                className="storyboards-stage-arrow storyboards-stage-arrow-next"
                aria-label="下一个分镜"
                disabled={!selectedShot || selectedShotIndex >= selectedStoryboard.shots.length - 1}
                onClick={() => selectAdjacentShot(1)}
              >
                <StoryboardIcon name="chevron-right" size={16} title="下一个分镜" />
              </button>
            </div>
          </section>

          <aside className="storyboards-inspector" aria-label="镜头检查器" inert={!selectedShot}>
            <label className="storyboards-section-label" htmlFor="storyboards-instruction">
              修改指令
            </label>
            <div className="storyboards-instruction-field">
              <StoryboardReferenceImageTray
                disabled={pendingReferenceImageCount > 0}
                images={referenceImages}
                onFilesSelected={ingestReferenceImages}
                onRemove={removeReferenceImage}
              />
              <StoryboardInstructionEditor
                ariaLabel="修改指令"
                document={instructionDocument}
                id="storyboards-instruction"
                insertReferenceRequest={instructionReferenceInsertRequest}
                onDocumentChange={setInstructionDocument}
                onFilesSelected={ingestReferenceImages}
                placeholder="描述你想怎么改这一镜…"
                references={instructionReferences}
              />
              {referenceImageErrorMessage ? (
                <p className="storyboards-reference-image-error" role="alert">
                  {referenceImageErrorMessage}
                </p>
              ) : null}
            </div>

            <div className="storyboards-model-select">
              <button
                type="button"
                className="storyboards-model-trigger"
                aria-expanded={modelMenuOpen}
                aria-haspopup="listbox"
                aria-label="选择画面模型"
                onClick={() => setModelMenuOpen((current) => !current)}
              >
                <span className="storyboards-model-logo">
                  <StoryboardIcon
                    name={selectedModelOption?.icon ?? 'model-nano-banana'}
                    size={18}
                    title={selectedModelOption?.name ?? '画面模型'}
                  />
                </span>
                <span className="storyboards-model-copy">
                  <strong>{selectedModelOption?.name}</strong>
                  <small>{selectedModelOption?.description}</small>
                </span>
                <StoryboardIcon name="chevron-down" size={14} title="展开画面模型" />
              </button>
              {modelMenuOpen ? (
                <div className="storyboards-model-menu" role="listbox" aria-label="画面模型">
                  {MODEL_OPTIONS.map((model) => (
                    <button
                      key={model.name}
                      type="button"
                      role="option"
                      aria-label={`使用 ${model.name} 模型`}
                      aria-selected={model.name === selectedModelOption?.name}
                      onClick={() => {
                        setSelectedModel(model.name)
                        setModelMenuOpen(false)
                      }}
                    >
                      <span className="storyboards-model-logo">
                        <StoryboardIcon name={model.icon} size={17} title={model.name} />
                      </span>
                      <span className="storyboards-model-copy">
                        <strong>{model.name}</strong>
                        <small>{model.description}</small>
                      </span>
                      {model.name === selectedModelOption?.name ? (
                        <StoryboardIcon name="check" size={15} title="当前模型" />
                      ) : null}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>

            <button
              type="button"
              className="storyboards-submit-button"
              disabled={!selectedShot}
              onClick={submitRevision}
            >
              提交修改 · AI 重绘
            </button>

            <div className="storyboards-inspector-divider" />
            <div className="storyboards-version-heading">
              <span className="storyboards-section-label">版本记录</span>
              <span>共 {versionCount} 版</span>
            </div>
            <div className="storyboards-version-list" data-testid="storyboard-inspector-shot">
              {selectedShot ? (
                <>
                  {localRevisions.map((revision, index) => (
                    <article
                      key={`${selectedShot.id}-local-${index}`}
                      className="storyboards-version-card"
                    >
                      {selectedShot.previewUrl ? (
                        <img src={selectedShot.previewUrl} alt="" />
                      ) : (
                        <span className="storyboards-version-card-empty" aria-hidden="true">
                          <StoryboardIcon name="brand" size={18} title="空白版本" />
                        </span>
                      )}
                      <span className="storyboards-version-card-overlay">
                        <span>
                          <strong>v{versionCount - index}</strong>
                          {index === 0 ? <b>当前</b> : null}
                        </span>
                        <small>
                          {revision.instruction}
                          {revision.referenceImages.length > 0
                            ? ` · ${revision.referenceImages.length} 张参考图`
                            : null}
                        </small>
                      </span>
                    </article>
                  ))}
                  {selectedShot.versions.map((version, index) => (
                    <article
                      key={version.id}
                      className="storyboards-version-card"
                      data-current={localRevisions.length === 0 && index === 0}
                    >
                      {selectedShot.previewUrl ? (
                        <img src={selectedShot.previewUrl} alt="" />
                      ) : (
                        <span className="storyboards-version-card-empty" aria-hidden="true">
                          <StoryboardIcon name="brand" size={18} title="空白版本" />
                        </span>
                      )}
                      <span className="storyboards-version-card-overlay">
                        <span>
                          <strong>{version.label}</strong>
                          {localRevisions.length === 0 && index === 0 ? <b>当前</b> : null}
                        </span>
                        <small>
                          {version.instruction}
                          {version.createdAt === '当前' ? null : <time>{version.createdAt}</time>}
                        </small>
                      </span>
                    </article>
                  ))}
                </>
              ) : null}
            </div>
          </aside>
        </div>
      </div>

      <footer className="storyboards-timeline" aria-label="故事板时间线">
        <div className="storyboards-timeline-heading">
          <div className="storyboards-timeline-title">
            <strong>故事板</strong>
            <span>
              {selectedShot
                ? `当前 SHOT ${String(selectedShot.sequence).padStart(2, '0')} · ${selectedShot.title}`
                : '等待 Agent 创作'}
            </span>
          </div>
          {!selectedMonitorUi.open && agentRunRecord && !selectedMonitorUi.dismissed ? (
            <StoryboardAgentSummary
              onDismiss={() => dismissSummary(selectedStoryboard.conversationId)}
              onOpen={() => openRun(selectedStoryboard.conversationId)}
              run={agentRunRecord}
            />
          ) : null}
          {selectedShot ? (
            <small>
              {selectedStoryboard.shots.length} 个镜头 · 共 {formatTimelineTime(totalDuration)}
            </small>
          ) : null}
        </div>
        <div className="storyboards-timeline-scroll">
          <div
            className="storyboards-timeline-inner"
            style={
              {
                '--storyboard-timeline-width': `${totalDuration * TIMELINE_PIXELS_PER_SECOND}px`,
              } as CSSProperties
            }
          >
            <div className="storyboards-timeline-ruler" aria-hidden="true">
              {timelineTicks.map((second) => (
                <span
                  key={second}
                  data-major={second % 5 === 0}
                  style={{ left: totalDuration > 0 ? `${(second / totalDuration) * 100}%` : '0%' }}
                >
                  {second % 5 === 0 ? <b>{formatTimelineTime(second)}</b> : null}
                </span>
              ))}
            </div>
            <div className="storyboards-timeline-frames">
              {selectedStoryboard.shots.length === 0 ? (
                <div className="storyboards-timeline-empty-state">
                  <span className="storyboards-timeline-frame-empty">
                    <img
                      alt=""
                      aria-hidden="true"
                      className="storyboards-timeline-frame-empty-art"
                      src={emptyShotFilmFrameUrl}
                    />
                    <span className="storyboards-timeline-frame-empty-copy">
                      <strong>等待 Agent 创作</strong>
                      <small>尚未生成镜头</small>
                    </span>
                  </span>
                </div>
              ) : null}
              {selectedStoryboard.shots.map((shot, shotIndex) => {
                const previousDuration = selectedStoryboard.shots
                  .slice(0, shotIndex)
                  .reduce((duration, previousShot) => duration + previousShot.durationSeconds, 0)
                const shotWidth = (shot.durationSeconds / totalDuration) * 100
                const shotEnd = ((previousDuration + shot.durationSeconds) / totalDuration) * 100
                const insertPosition =
                  shotIndex === selectedStoryboard.shots.length - 1
                    ? `${shotEnd}%`
                    : `calc(${shotEnd}% - ${TIMELINE_FRAME_GAP / 2}px)`
                const frameStyle = {
                  left: `${(previousDuration / totalDuration) * 100}%`,
                  width:
                    shotIndex === selectedStoryboard.shots.length - 1
                      ? `${shotWidth}%`
                      : `calc(${shotWidth}% - ${TIMELINE_FRAME_GAP}px)`,
                }

                return (
                  <Fragment key={shot.id}>
                    <button
                      type="button"
                      aria-label={`镜头 ${shot.sequence}：${shot.title}`}
                      aria-pressed={shot.id === selectedShot?.id}
                      className="storyboards-timeline-frame"
                      data-draft-state={shot.draftState}
                      style={frameStyle}
                      onClick={() => selectShot(shot)}
                    >
                      {shot.previewUrl ? (
                        <img src={shot.previewUrl} alt="" />
                      ) : (
                        <span className="storyboards-timeline-frame-empty">
                          <img
                            alt=""
                            aria-hidden="true"
                            className="storyboards-timeline-frame-empty-art"
                            src={emptyShotFilmFrameUrl}
                          />
                          <span className="storyboards-timeline-frame-empty-copy">
                            <span>SHOT {String(shot.sequence).padStart(2, '0')}</span>
                            <strong>空白分镜</strong>
                            <small>等待添加画面</small>
                          </span>
                        </span>
                      )}
                      {shot.draftState === 'blank' ? null : (
                        <span className="storyboards-timeline-frame-number">
                          SHOT {String(shot.sequence).padStart(2, '0')}
                        </span>
                      )}
                      {shot.draftState === 'blank' ? null : (
                        <span className="storyboards-timeline-frame-copy">
                          <strong>{shot.title}</strong>
                          <small>
                            {shot.aspectRatio} · {shot.shotSize} ·{' '}
                            {formatSeconds(shot.durationSeconds)}
                          </small>
                        </span>
                      )}
                    </button>
                    <button
                      type="button"
                      className="storyboards-timeline-insert-control"
                      data-edge={
                        shotIndex === selectedStoryboard.shots.length - 1 ? 'end' : undefined
                      }
                      style={{ left: insertPosition }}
                      aria-label={`在镜头 ${shot.sequence} 后插入空白分镜`}
                      onClick={(event) => {
                        event.currentTarget.blur()
                        insertBlankShot(shotIndex)
                      }}
                    >
                      <i aria-hidden="true" />
                      <span className="storyboards-timeline-insert-action" aria-hidden="true">
                        <StoryboardIcon name="plus" size={13} title="插入空白分镜" />
                      </span>
                    </button>
                  </Fragment>
                )
              })}
            </div>
          </div>
        </div>

        {selectedAgentRun && selectedMonitorUi.open ? (
          <StoryboardAgentMonitor
            expanded={selectedMonitorUi.expanded}
            nowMs={nowMs}
            onClose={() => closeMonitor(selectedStoryboard.conversationId)}
            onToggleExpanded={() => toggleMonitorExpanded(selectedStoryboard.conversationId)}
            run={selectedAgentRun}
          />
        ) : null}
      </footer>

      {notice ? (
        <div className="storyboards-toast" role="status">
          <i aria-hidden="true" />
          <span>{notice}</span>
          <button type="button" aria-label="关闭提示" onClick={() => setNotice('')}>
            <StoryboardIcon name="close" size={13} title="关闭提示" />
          </button>
        </div>
      ) : null}
    </main>
  )
}
