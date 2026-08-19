import type { NodeTypes } from '@xyflow/react'
import type { CanvasViewportExtraNode } from '@/features/project-canvas/components/CanvasViewport'
import type {
  ProjectCanvasVideoGenerationOutputAsset,
  ProjectCanvasVideoGenerationTask,
  ProjectCanvasVideoGenerationTaskStatus,
} from '@/features/project-canvas/components/nodes/project-canvas-node.types'
import StoryboardWorkbenchCanvasNode from '@/features/project-canvas/components/nodes/storyboard-workbench/StoryboardWorkbenchCanvasNode'
import type {
  StoryboardWorkbenchAddShotInput,
  StoryboardWorkbenchCanvasNodeData,
  StoryboardWorkbenchMediaItem,
  StoryboardWorkbenchProjectCanvasNode,
  StoryboardWorkbenchRedoShotInput,
  StoryboardWorkbenchSelectShotInput,
  StoryboardWorkbenchShot,
  StoryboardWorkbenchUploadShotMediaInput,
} from '@/features/project-canvas/components/nodes/storyboard-workbench/storyboard-workbench.types'
import {
  type ProducerVideoOutputAsset,
  producerVideoOutputAssetsByGenerationId,
} from '@/features/projects'
import { isRecord, nonEmptyString } from '@/shared/lib/guards'
import { createOssVideoSnapshotUrl } from '@/shared/ui/media'

const CANVAS_VIDEO_STORYBOARD_NODE_SIZE = {
  height: 2032,
  width: 3492,
} as const
export const CANVAS_VIDEO_DEFAULT_ASPECT_RATIO = '16:9'
const CANVAS_VIDEO_STORYBOARD_TITLE = 'Storyboard'
const CANVAS_VIDEO_CREATED_AT_SECONDS_BOUNDARY = 10_000_000_000
const CANVAS_VIDEO_STORYBOARD_NODE_GAP = 280
const CANVAS_VIDEO_STORYBOARD_ROOT_NODE_ID = 'storyboard-workbench:root'
const CANVAS_VIDEO_REFERENCE_MEDIA_MIME_TYPE = {
  audio: 'audio/mpeg',
  image: 'image/png',
  video: 'video/mp4',
} as const satisfies Record<StoryboardWorkbenchMediaItem['mediaType'], string>
const CANVAS_VIDEO_OUTPUT_MEDIA_MIME_TYPE = 'video/mp4'

export const CANVAS_VIDEO_STORYBOARD_NODE_TYPES = {
  'storyboard-workbench-node': StoryboardWorkbenchCanvasNode,
} satisfies NodeTypes

interface CreateCanvasVideoStoryboardNodeInput {
  activeShotId?: string
  aspectRatio?: string
  draftShotMediaById?: Record<string, StoryboardWorkbenchMediaItem[]>
  draftShotIds?: string[]
  id?: string
  onAddShot?: (input: StoryboardWorkbenchAddShotInput) => void
  onRedoShot?: (input: StoryboardWorkbenchRedoShotInput) => void
  onSelectShot?: (input: StoryboardWorkbenchSelectShotInput) => void
  onUploadShotMedia?: (input: StoryboardWorkbenchUploadShotMediaInput) => void | Promise<void>
  position?: { x: number; y: number }
  tasks: ProjectCanvasVideoGenerationTask[]
  title?: string
}

interface CreateCanvasVideoStoryboardNodesInput extends CreateCanvasVideoStoryboardNodeInput {
  renderWhenEmpty?: boolean
}

const requiredString = (value: unknown, field: string) => {
  const normalized = nonEmptyString(value)

  if (!normalized) {
    throw new Error(`视频生成任务缺少 ${field}`)
  }

  return normalized
}

const requiredPositiveInteger = (value: unknown, field: string) => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`视频生成任务 ${field} 必须是正整数`)
  }

  return value
}

const requiredCreatedAtIsoString = (value: unknown, field: string) => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const milliseconds = value < CANVAS_VIDEO_CREATED_AT_SECONDS_BOUNDARY ? value * 1000 : value

    return new Date(milliseconds).toISOString()
  }

  const normalized = nonEmptyString(value)

  if (normalized) {
    const parsed = Date.parse(normalized)

    if (Number.isFinite(parsed)) {
      return new Date(parsed).toISOString()
    }
  }

  throw new Error(`视频生成任务 ${field} 必须是有效时间`)
}

const requiredRequestPayload = (generation: Record<string, unknown>, generationId: string) => {
  if (!isRecord(generation.requestPayload)) {
    throw new Error(`视频生成任务 ${generationId} 缺少 requestPayload`)
  }

  return generation.requestPayload
}

const requiredParams = (requestPayload: Record<string, unknown>, generationId: string) => {
  if (!isRecord(requestPayload.params)) {
    throw new Error(`视频生成任务 ${generationId} 的 requestPayload.params 必须是对象`)
  }

  return requestPayload.params
}

const requiredInputs = (
  requestPayload: Record<string, unknown>,
  generationId: string,
): unknown[] => {
  if (!Array.isArray(requestPayload.inputs)) {
    throw new Error(`视频生成任务 ${generationId} 的 requestPayload.inputs 必须是数组`)
  }

  return requestPayload.inputs as unknown[]
}

const generationInputUrls = (inputs: unknown[], mediaType: 'audio' | 'image' | 'video') => {
  const urls: string[] = []

  for (const [index, input] of inputs.entries()) {
    if (!isRecord(input)) {
      throw new Error(`视频生成任务 requestPayload.inputs[${index.toString()}] 必须是对象`)
    }

    const kind = requiredString(input.kind, `requestPayload.inputs[${index.toString()}].kind`)

    if (kind !== 'url') {
      throw new Error(`视频生成任务 requestPayload.inputs[${index.toString()}].kind 当前仅支持 url`)
    }

    const inputMediaType = requiredString(
      input.mediaType,
      `requestPayload.inputs[${index.toString()}].mediaType`,
    )

    if (inputMediaType !== 'image' && inputMediaType !== 'video' && inputMediaType !== 'audio') {
      throw new Error(`视频生成任务 requestPayload.inputs[${index.toString()}].mediaType 无效`)
    }

    if (inputMediaType === mediaType) {
      urls.push(requiredString(input.url, `requestPayload.inputs[${index.toString()}].url`))
    }
  }

  return urls
}

export const canvasVideoGenerationTaskStatusFromRawStatus = (
  status: unknown,
): ProjectCanvasVideoGenerationTaskStatus => {
  switch (status) {
    case 'created':
      return 'queued'
    case 'submitted':
      return 'running'
    case 'completed':
      return 'succeeded'
    case 'failed':
      return 'failed'
    default:
      throw new Error(`未知视频生成状态: ${String(status)}`)
  }
}

export const videoGenerationTaskFromGenerationRecord = (
  generation: Record<string, unknown>,
  outputAsset?: ProducerVideoOutputAsset,
): ProjectCanvasVideoGenerationTask => {
  if (nonEmptyString(generation.assetType) !== 'video') {
    throw new Error('视频 storyboard 只能读取 assetType=video 的 generation')
  }

  const generationId = requiredString(generation.id, 'id')
  const requestPayload = requiredRequestPayload(generation, generationId)

  if (
    requiredString(requestPayload.type, `generation(${generationId}).requestPayload.type`) !==
    'video'
  ) {
    throw new Error(`视频生成任务 ${generationId} 的 requestPayload.type 必须是 video`)
  }

  const params = requiredParams(requestPayload, generationId)
  const inputs = requiredInputs(requestPayload, generationId)

  return {
    aspectRatio: requiredString(
      params.aspectRatio,
      `generation(${generationId}).requestPayload.params.aspectRatio`,
    ),
    audioUrls: generationInputUrls(inputs, 'audio'),
    createdAt: requiredCreatedAtIsoString(
      generation.createdAt,
      `generation(${generationId}).createdAt`,
    ),
    imageUrls: generationInputUrls(inputs, 'image'),
    ...(outputAsset ? { outputAsset: projectCanvasVideoGenerationOutputAsset(outputAsset) } : {}),
    prompt: requiredString(
      requestPayload.prompt,
      `generation(${generationId}).requestPayload.prompt`,
    ),
    seconds: requiredPositiveInteger(
      params.durationSeconds,
      `generation(${generationId}).requestPayload.params.durationSeconds`,
    ),
    shotIndex: requiredPositiveInteger(
      params.shotIndex,
      `generation(${generationId}).requestPayload.params.shotIndex`,
    ),
    status: canvasVideoGenerationTaskStatusFromRawStatus(generation.status),
    taskId: generationId,
    videoUrls: generationInputUrls(inputs, 'video'),
  }
}

const projectCanvasVideoGenerationOutputAsset = (
  asset: ProducerVideoOutputAsset,
): ProjectCanvasVideoGenerationOutputAsset => ({
  assetId: asset.id,
  ...(asset.mimeType ? { mimeType: asset.mimeType } : {}),
  ...(asset.thumbnailUrl ? { thumbnailUrl: asset.thumbnailUrl } : {}),
  url: asset.url,
})

const canvasVideoTaskCreatedAtMs = (task: ProjectCanvasVideoGenerationTask) =>
  Date.parse(task.createdAt)

const sortCanvasVideoTasksByShotIndex = (tasks: ProjectCanvasVideoGenerationTask[]) =>
  [...tasks].sort((firstTask, secondTask) => firstTask.shotIndex - secondTask.shotIndex)

const compareCanvasVideoTasksByChronology = (
  firstTask: ProjectCanvasVideoGenerationTask,
  secondTask: ProjectCanvasVideoGenerationTask,
) => {
  const createdAtDelta =
    canvasVideoTaskCreatedAtMs(firstTask) - canvasVideoTaskCreatedAtMs(secondTask)

  if (createdAtDelta !== 0) {
    return createdAtDelta
  }

  if (firstTask.shotIndex !== secondTask.shotIndex) {
    return firstTask.shotIndex - secondTask.shotIndex
  }

  return firstTask.taskId.localeCompare(secondTask.taskId)
}

const sortCanvasVideoTasksByCreatedAt = (tasks: ProjectCanvasVideoGenerationTask[]) =>
  [...tasks].sort(compareCanvasVideoTasksByChronology)

const canvasVideoTaskSnapshotSignature = (tasks: ProjectCanvasVideoGenerationTask[]) =>
  tasks.map((task) => `${task.shotIndex.toString()}:${task.taskId}`).join('|')

const canvasVideoGenerationRecordTaskPair = (generation: Record<string, unknown>) => ({
  generation,
  task: videoGenerationTaskFromGenerationRecord(generation),
})

export const videoGenerationTasksFromGenerationFacts = (
  generations: Record<string, unknown>[],
  { assets = [] }: { assets?: Record<string, unknown>[] } = {},
) => {
  const tasksByShotIndex = new Map<number, ProjectCanvasVideoGenerationTask>()
  const outputAssetsByGenerationId = producerVideoOutputAssetsByGenerationId(assets)

  for (const generation of generations) {
    if (nonEmptyString(generation.assetType) !== 'video') {
      continue
    }

    const generationId = requiredString(generation.id, 'id')
    const task = videoGenerationTaskFromGenerationRecord(
      generation,
      outputAssetsByGenerationId.get(generationId),
    )
    const currentTask = tasksByShotIndex.get(task.shotIndex)

    if (!currentTask || compareCanvasVideoTasksByChronology(task, currentTask) >= 0) {
      tasksByShotIndex.set(task.shotIndex, task)
    }
  }

  return sortCanvasVideoTasksByShotIndex([...tasksByShotIndex.values()])
}

export const videoGenerationStoryboardTaskGroupsFromGenerationFacts = (
  generations: Record<string, unknown>[],
  { assets = [] }: { assets?: Record<string, unknown>[] } = {},
) => {
  const outputAssetsByGenerationId = producerVideoOutputAssetsByGenerationId(assets)
  const timelineTasks = sortCanvasVideoTasksByCreatedAt(
    generations
      .filter((generation) => nonEmptyString(generation.assetType) === 'video')
      .map((generation) =>
        videoGenerationTaskFromGenerationRecord(
          generation,
          outputAssetsByGenerationId.get(requiredString(generation.id, 'id')),
        ),
      ),
  )
  const currentTasksByShotIndex = new Map<number, ProjectCanvasVideoGenerationTask>()
  const snapshots: ProjectCanvasVideoGenerationTask[][] = []
  let lastSnapshotSignature = ''
  const pushCurrentSnapshot = () => {
    if (currentTasksByShotIndex.size === 0) {
      return
    }

    const snapshot = sortCanvasVideoTasksByShotIndex([...currentTasksByShotIndex.values()])
    const signature = canvasVideoTaskSnapshotSignature(snapshot)

    if (signature === lastSnapshotSignature) {
      return
    }

    snapshots.push(snapshot)
    lastSnapshotSignature = signature
  }

  for (const task of timelineTasks) {
    const currentTask = currentTasksByShotIndex.get(task.shotIndex)

    if (currentTask && currentTask.status !== 'failed') {
      pushCurrentSnapshot()
    }

    currentTasksByShotIndex.set(task.shotIndex, task)
  }

  pushCurrentSnapshot()

  return snapshots
}

export const getVideoGenerationVersionsByShot = (
  generations: Record<string, unknown>[],
  shotIndex: number,
) => {
  const targetShotIndex = requiredPositiveInteger(shotIndex, 'shotIndex')

  return generations
    .filter((generation) => nonEmptyString(generation.assetType) === 'video')
    .map(canvasVideoGenerationRecordTaskPair)
    .filter(({ task }) => task.shotIndex === targetShotIndex)
    .sort(({ task: firstTask }, { task: secondTask }) =>
      compareCanvasVideoTasksByChronology(secondTask, firstTask),
    )
    .map(({ generation }) => generation)
}

export const getCanvasVideoStoryboardAspectRatio = (tasks: ProjectCanvasVideoGenerationTask[]) =>
  tasks.at(-1)?.aspectRatio ?? CANVAS_VIDEO_DEFAULT_ASPECT_RATIO

export const getNextCanvasVideoShotIndex = (tasks: ProjectCanvasVideoGenerationTask[]) =>
  tasks.reduce((maxShotIndex, task) => Math.max(maxShotIndex, task.shotIndex), 0) + 1

const createCanvasVideoStoryboardShot = (
  task: ProjectCanvasVideoGenerationTask,
): StoryboardWorkbenchShot => ({
  durationSeconds: task.seconds,
  id: `canvas-video-storyboard-shot:${task.taskId}`,
  includeInPreviewTimeline: Boolean(task.outputAsset),
  media: createCanvasVideoStoryboardOutputMedia(task),
  prompt: task.prompt,
  referenceMedia: createCanvasVideoStoryboardReferenceMedia(task),
  shotIndex: task.shotIndex,
  status: task.status,
  title: `镜头 ${task.shotIndex.toString()}`,
})

const createCanvasVideoStoryboardOutputMedia = (
  task: ProjectCanvasVideoGenerationTask,
): StoryboardWorkbenchMediaItem[] => {
  if (!task.outputAsset) {
    return []
  }

  const thumbnailUrl =
    task.outputAsset.thumbnailUrl ?? createOssVideoSnapshotUrl(task.outputAsset.url)

  return [
    {
      aspectRatio: task.aspectRatio,
      durationSeconds: task.seconds,
      fileName: `video_${task.shotIndex.toString()}`,
      id: `canvas-video-generation-output:${task.taskId}:${task.outputAsset.assetId}`,
      mediaType: 'video',
      mimeType: task.outputAsset.mimeType ?? CANVAS_VIDEO_OUTPUT_MEDIA_MIME_TYPE,
      ...(thumbnailUrl ? { thumbnailUrl } : {}),
      url: task.outputAsset.url,
    },
  ]
}

const createCanvasVideoStoryboardReferenceMedia = (
  task: ProjectCanvasVideoGenerationTask,
): StoryboardWorkbenchMediaItem[] => [
  ...task.imageUrls.map((url, index) =>
    createCanvasVideoStoryboardReferenceMediaItem(task, 'image', url, index),
  ),
  ...task.videoUrls.map((url, index) =>
    createCanvasVideoStoryboardReferenceMediaItem(task, 'video', url, index),
  ),
  ...task.audioUrls.map((url, index) =>
    createCanvasVideoStoryboardReferenceMediaItem(task, 'audio', url, index),
  ),
]

const createCanvasVideoStoryboardReferenceMediaItem = (
  task: ProjectCanvasVideoGenerationTask,
  mediaType: StoryboardWorkbenchMediaItem['mediaType'],
  url: string,
  index: number,
): StoryboardWorkbenchMediaItem => ({
  aspectRatio: task.aspectRatio,
  fileName: `${mediaType}_${(index + 1).toString()}`,
  id: `canvas-video-generation-reference:${task.taskId}:${mediaType}:${(index + 1).toString()}`,
  mediaType,
  mimeType: CANVAS_VIDEO_REFERENCE_MEDIA_MIME_TYPE[mediaType],
  url,
})

const createCanvasVideoStoryboardDraftShot = ({
  draftShotId,
  media,
  shotIndex,
}: {
  draftShotId: string
  media?: StoryboardWorkbenchMediaItem[]
  shotIndex: number
}): StoryboardWorkbenchShot => ({
  id: draftShotId,
  includeInPreviewTimeline: false,
  media: media ?? [],
  prompt: '',
  shotIndex,
  status: 'draft',
  title: `镜头 ${shotIndex.toString()}`,
})

const createCanvasVideoStoryboardShots = ({
  draftShotMediaById,
  draftShotIds,
  tasks,
}: {
  draftShotMediaById?: Record<string, StoryboardWorkbenchMediaItem[]>
  draftShotIds: string[]
  tasks: ProjectCanvasVideoGenerationTask[]
}) => [
  ...tasks.map(createCanvasVideoStoryboardShot),
  ...draftShotIds.map((draftShotId, draftShotIndex) =>
    createCanvasVideoStoryboardDraftShot({
      draftShotId,
      media: draftShotMediaById?.[draftShotId],
      shotIndex: getNextCanvasVideoShotIndex(tasks) + draftShotIndex,
    }),
  ),
]

const createCanvasVideoStoryboardData = ({
  activeShotId,
  aspectRatio,
  draftShotMediaById,
  draftShotIds,
  onAddShot,
  onRedoShot,
  onSelectShot,
  onUploadShotMedia,
  tasks,
  title,
}: Required<Pick<CreateCanvasVideoStoryboardNodeInput, 'tasks'>> &
  Omit<CreateCanvasVideoStoryboardNodeInput, 'position'>): StoryboardWorkbenchCanvasNodeData => ({
  activeShotId,
  aspectRatio: aspectRatio ?? getCanvasVideoStoryboardAspectRatio(tasks),
  currentTimeSeconds: 0,
  onAddShot,
  onRedoShot,
  onSelectShot,
  onUploadShotMedia,
  shots: createCanvasVideoStoryboardShots({
    draftShotIds: draftShotIds ?? [],
    draftShotMediaById,
    tasks,
  }),
  title: title ?? CANVAS_VIDEO_STORYBOARD_TITLE,
})

export const createCanvasVideoStoryboardNode = ({
  activeShotId,
  aspectRatio,
  draftShotMediaById,
  draftShotIds = [],
  id = CANVAS_VIDEO_STORYBOARD_ROOT_NODE_ID,
  onAddShot,
  onRedoShot,
  onSelectShot,
  onUploadShotMedia,
  position = { x: 360, y: 300 },
  tasks,
  title,
}: CreateCanvasVideoStoryboardNodeInput): StoryboardWorkbenchProjectCanvasNode => ({
  data: createCanvasVideoStoryboardData({
    activeShotId,
    aspectRatio,
    draftShotMediaById,
    draftShotIds,
    onAddShot,
    onRedoShot,
    onSelectShot,
    onUploadShotMedia,
    tasks,
    title,
  }),
  dragHandle: '.canvas-node-drag-surface',
  draggable: true,
  id,
  position,
  selectable: false,
  style: CANVAS_VIDEO_STORYBOARD_NODE_SIZE,
  type: 'storyboard-workbench-node',
})

export const createCanvasVideoStoryboardExtraNode = (
  input: CreateCanvasVideoStoryboardNodeInput,
): CanvasViewportExtraNode => createCanvasVideoStoryboardNode(input)

export const createCanvasVideoStoryboardNodes = ({
  draftShotIds = [],
  renderWhenEmpty = false,
  ...input
}: CreateCanvasVideoStoryboardNodesInput): CanvasViewportExtraNode[] => {
  if (!renderWhenEmpty && input.tasks.length === 0 && draftShotIds.length === 0) {
    return []
  }

  return [
    createCanvasVideoStoryboardNode({
      ...input,
      draftShotIds,
    }),
  ]
}

export const createCanvasVideoStoryboardNodesFromGenerationFacts = ({
  assets = [],
  draftShotIds = [],
  generations,
  position,
  renderWhenEmpty = false,
  ...input
}: Omit<CreateCanvasVideoStoryboardNodesInput, 'tasks'> & {
  assets?: Record<string, unknown>[]
  generations: Record<string, unknown>[]
}): CanvasViewportExtraNode[] => {
  const taskGroups = videoGenerationStoryboardTaskGroupsFromGenerationFacts(generations, { assets })

  if (taskGroups.length === 0) {
    return createCanvasVideoStoryboardNodes({
      ...input,
      draftShotIds,
      position,
      renderWhenEmpty,
      tasks: [],
    })
  }

  const basePosition = position ?? { x: 360, y: 300 }
  const lastTaskGroupIndex = taskGroups.length - 1

  return taskGroups.map((tasks, taskGroupIndex) => {
    const previousTasks = taskGroups[taskGroupIndex - 1]
    const previousTasksByShotIndex = new Map(
      previousTasks?.map((task) => [task.shotIndex, task] as const) ?? [],
    )
    const boundaryTask =
      taskGroupIndex === 0
        ? null
        : tasks.find((task) => previousTasksByShotIndex.get(task.shotIndex)?.taskId !== task.taskId)

    if (taskGroupIndex > 0 && !boundaryTask) {
      throw new Error('Storyboard revision snapshot 缺少稳定的 generation 边界。')
    }

    const nodeId = boundaryTask
      ? `storyboard-workbench:revision:${boundaryTask.taskId}`
      : CANVAS_VIDEO_STORYBOARD_ROOT_NODE_ID

    return createCanvasVideoStoryboardNode({
      ...input,
      draftShotIds: taskGroupIndex === lastTaskGroupIndex ? draftShotIds : [],
      id: nodeId,
      position: {
        x:
          basePosition.x +
          taskGroupIndex *
            (CANVAS_VIDEO_STORYBOARD_NODE_SIZE.width + CANVAS_VIDEO_STORYBOARD_NODE_GAP),
        y: basePosition.y,
      },
      tasks,
      title:
        taskGroups.length === 1
          ? CANVAS_VIDEO_STORYBOARD_TITLE
          : `${CANVAS_VIDEO_STORYBOARD_TITLE} ${(taskGroupIndex + 1).toString()}`,
    })
  })
}
