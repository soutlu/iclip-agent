import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  CANVAS_VIDEO_DEFAULT_ASPECT_RATIO,
  CANVAS_VIDEO_STORYBOARD_NODE_TYPES,
  createCanvasVideoStoryboardNodesFromGenerationFacts,
  getCanvasVideoStoryboardAspectRatio,
  getNextCanvasVideoShotIndex,
  type ProjectCanvasVideoGenerationTask,
  type ProjectCanvasWorkspaceNodeInput,
  type StoryboardWorkbenchAddShotInput,
  type StoryboardWorkbenchMediaItem,
  type StoryboardWorkbenchRedoShotInput,
  type StoryboardWorkbenchSelectShotInput,
  type StoryboardWorkbenchUploadShotMediaInput,
  videoGenerationTasksFromGenerationFacts,
} from '@/features/project-canvas'
import CanvasVideoComposer, {
  type CanvasVideoComposerAppendFilesInput,
  type CanvasVideoComposerDraftInput,
  type CanvasVideoComposerSubmitInput,
} from '@/features/project-workspace/components/CanvasVideoComposer'
import ProjectCanvasStage from '@/features/project-workspace/components/ProjectCanvasStage'
import ProjectCanvasLayoutCoordinator from '@/features/project-workspace/components/ProjectCanvasLayoutCoordinator'
import ProjectHeaderLeft from '@/features/project-workspace/components/ProjectHeaderLeft'
import ProjectHeaderRight from '@/features/project-workspace/components/ProjectHeaderRight'
import ProjectMouseGlow from '@/features/project-workspace/components/ProjectMouseGlow'
import { ProjectWorkspaceProviders } from '@/features/project-workspace/components/ProjectPageProviders'
import {
  listProducerProjectAssets,
  producerGenerationRecordFromSubmission,
  producerGenerationRecordsKey,
  submitProjectVideoGeneration,
  useProducerGenerationRecords,
} from '@/features/projects'
import RouteBootShell from '@/shared/ui/RouteBootShell'
import {
  type ComposerFileAttachment,
  type ComposerFilePart,
  createComposerAttachmentsFromFiles,
  createRemoteComposerAttachmentsFromFileParts,
  formatComposerAttachmentErrors,
  revokeComposerAttachmentObjectUrls,
  VIDEO_GENERATION_ASPECT_RATIO_VALUES,
  type VideoGenerationAspectRatio,
} from '@/shared/composer'
import { errorFromUnknown } from '@/shared/lib/guards'

const CANVAS_VIDEO_DEFAULT_MEDIA_MIME_TYPE = {
  audio: 'audio/mpeg',
  image: 'image/png',
  video: 'video/mp4',
} as const satisfies Record<StoryboardWorkbenchMediaItem['mediaType'], string>
const CANVAS_VIDEO_INITIAL_DRAFT_SHOT_ID = 'canvas-video-storyboard-draft-shot:1'
const CANVAS_VIDEO_NEXT_DRAFT_SHOT_SEQUENCE_START = 2
const EMPTY_GENERATION_RECORDS_KEY = producerGenerationRecordsKey([])
const CANVAS_VIDEO_STORYBOARD_IMAGE_FILE_NAME_PATTERN = /\.(?:jpe?g|png|webp)$/iu

interface CanvasVideoWorkspaceProps {
  projectId: string
}

/**
 * 读取当前选中的 Direct Canvas 草稿镜头 id。
 *
 * @param draftShotIds - 当前未提交的草稿镜头 id。
 * @param activeShotId - 当前 storyboard 选中镜头 id。
 * @returns 当前 active 草稿；active 不是草稿时退回第一个草稿；没有草稿时返回 undefined。
 */
const getSelectedCanvasVideoDraftShotId = (draftShotIds: string[], activeShotId?: string) => {
  if (activeShotId && draftShotIds.includes(activeShotId)) {
    return activeShotId
  }

  return draftShotIds[0]
}

/**
 * 读取草稿镜头对应的业务镜头编号。
 *
 * @param params - 草稿编号参数。
 * @param params.draftShotId - 目标草稿镜头 id。
 * @param params.draftShotIds - 当前未提交的草稿镜头 id。
 * @param params.tasks - 已提交的视频生成任务列表。
 * @returns 草稿在当前 storyboard 中对应的正整数镜头编号。
 * @throws 当目标草稿不存在于当前草稿列表中时抛错。
 */
const getCanvasVideoDraftShotIndex = ({
  draftShotId,
  draftShotIds,
  tasks,
}: {
  draftShotId: string
  draftShotIds: string[]
  tasks: ProjectCanvasVideoGenerationTask[]
}) => {
  const draftOffset = draftShotIds.indexOf(draftShotId)

  if (draftOffset < 0) {
    throw new Error(`Direct Canvas draft shot ${draftShotId} is not available for submission.`)
  }

  return getNextCanvasVideoShotIndex(tasks) + draftOffset
}

/**
 * 判断比例是否为 Direct Canvas composer 支持的视频比例。
 *
 * @param value - 待检查比例。
 * @returns value 是否为支持的比例字面量。
 */
const isCanvasVideoAspectRatio = (value: string): value is VideoGenerationAspectRatio =>
  VIDEO_GENERATION_ASPECT_RATIO_VALUES.some((aspectRatio) => aspectRatio === value)

/**
 * 读取可写入 Direct Canvas composer 的视频比例。
 *
 * @param aspectRatio - storyboard 镜头或节点提供的视频比例。
 * @returns composer 支持的视频比例。
 * @throws 当比例不在 Direct Canvas composer 支持列表内时抛错。
 */
const readCanvasVideoDraftAspectRatio = (aspectRatio?: string): VideoGenerationAspectRatio => {
  const nextAspectRatio = aspectRatio ?? CANVAS_VIDEO_DEFAULT_ASPECT_RATIO

  if (isCanvasVideoAspectRatio(nextAspectRatio)) {
    return nextAspectRatio
  }

  throw new Error(
    `Storyboard redo aspect ratio is not supported by Direct Canvas composer: ${nextAspectRatio}.`,
  )
}

/**
 * 读取 storyboard 素材对应的 MIME 类型。
 *
 * @param media - storyboard 素材。
 * @returns 可写入 composer 远端附件的 MIME 类型。
 */
const getCanvasVideoStoryboardMediaMimeType = (media: StoryboardWorkbenchMediaItem) => {
  const mimeType = media.mimeType?.trim()

  return mimeType && mimeType.length > 0
    ? mimeType
    : CANVAS_VIDEO_DEFAULT_MEDIA_MIME_TYPE[media.mediaType]
}

/**
 * 将 storyboard 素材转换为 composer 远端附件 file part。
 *
 * @param media - storyboard 素材。
 * @returns composer 可恢复的远端 file part。
 * @throws 当素材缺少 URL 时抛错。
 */
const storyboardMediaToComposerFilePart = (
  media: StoryboardWorkbenchMediaItem,
): ComposerFilePart => {
  const url = media.url.trim()

  if (url.length === 0) {
    throw new Error(`Storyboard media ${media.id} is missing a URL for redo.`)
  }

  return {
    filename: media.fileName,
    mediaType: getCanvasVideoStoryboardMediaMimeType(media),
    type: 'file',
    url,
  }
}

const isCanvasVideoStoryboardImageFile = (file: File) => {
  const mediaType = file.type.trim().toLowerCase()

  return (
    mediaType.startsWith('image/') ||
    CANVAS_VIDEO_STORYBOARD_IMAGE_FILE_NAME_PATTERN.test(file.name)
  )
}

const composerAttachmentToStoryboardDraftMedia = (
  shotId: string,
  attachment: ComposerFileAttachment,
): StoryboardWorkbenchMediaItem => {
  if (attachment.kind !== 'image') {
    throw new Error(
      `Direct Canvas storyboard upload only supports image attachments: ${attachment.name}.`,
    )
  }

  return {
    fileName: attachment.name,
    id: `canvas-video-storyboard-draft-media:${shotId}:${attachment.id}`,
    mediaType: 'image',
    mimeType: attachment.mediaType,
    thumbnailUrl: attachment.thumbnailUrl,
    url: attachment.url,
  }
}

/**
 * 创建写入 Direct Canvas composer 的重做草稿。
 *
 * @param input - storyboard 镜头重做事件。
 * @param requestId - 草稿写入请求序号。
 * @returns 可传给 CanvasVideoComposer 的草稿。
 * @throws 当镜头 prompt 为空时抛错。
 */
const createCanvasVideoRedoDraftInput = (
  input: StoryboardWorkbenchRedoShotInput,
  requestId: number,
): CanvasVideoComposerDraftInput => {
  const prompt = input.prompt.trim()

  if (prompt.length === 0) {
    throw new Error(`Storyboard redo shot ${input.shotId} requires a prompt.`)
  }

  return {
    aspectRatio: readCanvasVideoDraftAspectRatio(input.aspectRatio),
    files: createRemoteComposerAttachmentsFromFileParts(
      input.media.map(storyboardMediaToComposerFilePart),
    ),
    prompt,
    requestId,
    seconds: input.seconds,
    shotIndex: input.shotIndex,
  }
}

const isAbortError = (error: unknown) => error instanceof Error && error.name === 'AbortError'

/**
 * 渲染 Direct Canvas 视频生成工作台。
 *
 * @param props - Canvas 视频工作台属性。
 * @param props.projectId - 当前 direct 项目文件夹 id。
 * @returns 不挂载 Agent runtime、聊天面板或 session tabs 的视频生成画布。
 */
export default function CanvasVideoWorkspace({ projectId }: CanvasVideoWorkspaceProps) {
  const draftShotSequenceRef = useRef(CANVAS_VIDEO_NEXT_DRAFT_SHOT_SEQUENCE_START)
  const {
    error: generationRecordsError,
    generationRecords,
    isInitialLoadPending: isGenerationRecordsInitialLoadPending,
    mergeLocalGenerationRecords,
  } = useProducerGenerationRecords({ projectId, type: 'project' })
  const [activeShotId, setActiveShotId] = useState<string | undefined>(
    CANVAS_VIDEO_INITIAL_DRAFT_SHOT_ID,
  )
  const [composerAppendFilesInput, setComposerAppendFilesInput] = useState<
    CanvasVideoComposerAppendFilesInput | undefined
  >(undefined)
  const [composerDraftInput, setComposerDraftInput] = useState<
    CanvasVideoComposerDraftInput | undefined
  >(undefined)
  const [composerFocusRequestId, setComposerFocusRequestId] = useState(0)
  const [assetRecords, setAssetRecords] = useState<Record<string, unknown>[]>([])
  const [assetRecordsError, setAssetRecordsError] = useState<Error | null>(null)
  const [draftShotMediaById, setDraftShotMediaById] = useState<
    Record<string, StoryboardWorkbenchMediaItem[]>
  >({})
  const [draftShotIds, setDraftShotIds] = useState<string[]>([CANVAS_VIDEO_INITIAL_DRAFT_SHOT_ID])
  const [isSubmitting, setIsSubmitting] = useState(false)
  const generationRecordsKey = useMemo(
    () => producerGenerationRecordsKey(generationRecords),
    [generationRecords],
  )
  const tasks = useMemo(
    () => videoGenerationTasksFromGenerationFacts(generationRecords, { assets: assetRecords }),
    [assetRecords, generationRecords],
  )
  const nextShotIndex = useMemo(
    () => getNextCanvasVideoShotIndex(tasks) + draftShotIds.length,
    [draftShotIds.length, tasks],
  )
  const storyboardAspectRatio = useMemo(() => getCanvasVideoStoryboardAspectRatio(tasks), [tasks])

  useEffect(() => {
    if (generationRecordsKey === EMPTY_GENERATION_RECORDS_KEY) {
      setAssetRecords([])
      setAssetRecordsError(null)
      return
    }

    const controller = new AbortController()

    void listProducerProjectAssets(projectId, { signal: controller.signal })
      .then((assets) => {
        setAssetRecords(assets)
        setAssetRecordsError(null)
      })
      .catch((error: unknown) => {
        if (isAbortError(error)) {
          return
        }

        setAssetRecordsError(errorFromUnknown(error))
      })

    return () => {
      controller.abort()
    }
  }, [generationRecordsKey, projectId])

  const handleAddShot = useCallback((input: StoryboardWorkbenchAddShotInput) => {
    if (input.afterShotId.trim().length === 0) {
      throw new Error('Storyboard add shot requires a non-empty afterShotId.')
    }

    const draftShotId = `canvas-video-storyboard-draft-shot:${draftShotSequenceRef.current.toString()}`

    draftShotSequenceRef.current += 1
    setDraftShotIds((currentDraftShotIds) => [...currentDraftShotIds, draftShotId])
    setActiveShotId(draftShotId)
    setComposerFocusRequestId((currentRequestId) => currentRequestId + 1)
  }, [])
  const handleRedoShot = useCallback((input: StoryboardWorkbenchRedoShotInput) => {
    setActiveShotId(input.shotId)
    setComposerDraftInput((currentDraftInput) =>
      createCanvasVideoRedoDraftInput(input, (currentDraftInput?.requestId ?? 0) + 1),
    )
  }, [])
  const handleSelectShot = useCallback((input: StoryboardWorkbenchSelectShotInput) => {
    const shotId = input.shotId.trim()

    if (shotId.length === 0) {
      throw new Error('Storyboard select shot requires a non-empty shotId.')
    }

    setActiveShotId(shotId)
  }, [])
  const handleUploadShotMedia = useCallback(
    async (input: StoryboardWorkbenchUploadShotMediaInput) => {
      const shotId = input.shotId.trim()

      if (shotId.length === 0) {
        throw new Error('Storyboard shot upload requires a non-empty shotId.')
      }

      const unsupportedFiles = input.files.filter((file) => !isCanvasVideoStoryboardImageFile(file))

      if (unsupportedFiles.length > 0) {
        throw new Error(
          `Direct Canvas storyboard 暂只支持上传本地图片：${unsupportedFiles[0]?.name ?? '未知文件'}`,
        )
      }

      if (input.files.length === 0) {
        return
      }

      const { attachments, errors } = await createComposerAttachmentsFromFiles(input.files)
      const errorMessage = formatComposerAttachmentErrors(errors)

      if (errorMessage) {
        revokeComposerAttachmentObjectUrls(attachments)
        throw new Error(errorMessage)
      }

      setDraftShotMediaById((currentMediaById) => ({
        ...currentMediaById,
        [shotId]: attachments.map((attachment) =>
          composerAttachmentToStoryboardDraftMedia(shotId, attachment),
        ),
      }))
      setActiveShotId(shotId)
      setComposerAppendFilesInput((currentInput) => ({
        files: attachments,
        requestId: (currentInput?.requestId ?? 0) + 1,
      }))
      setComposerFocusRequestId((currentRequestId) => currentRequestId + 1)
    },
    [],
  )
  const storyboardNodes = useMemo<ProjectCanvasWorkspaceNodeInput[]>(
    () =>
      createCanvasVideoStoryboardNodesFromGenerationFacts({
        activeShotId,
        aspectRatio: storyboardAspectRatio,
        assets: assetRecords,
        draftShotMediaById,
        draftShotIds,
        generations: generationRecords,
        onAddShot: handleAddShot,
        onRedoShot: handleRedoShot,
        onSelectShot: handleSelectShot,
        onUploadShotMedia: handleUploadShotMedia,
      }),
    [
      activeShotId,
      assetRecords,
      draftShotMediaById,
      draftShotIds,
      generationRecords,
      handleAddShot,
      handleRedoShot,
      handleSelectShot,
      handleUploadShotMedia,
      storyboardAspectRatio,
    ],
  )

  /**
   * 提交 Direct Canvas 视频生成任务。
   *
   * @param input - Canvas 输入框上传准备完成后的 prompt、媒体 URL 与视频参数。
   * @returns 无返回值；后端响应无效时由 helper 抛错并阻止创建节点。
   */
  const handleSubmit = useCallback(
    async (input: CanvasVideoComposerSubmitInput) => {
      if (isSubmitting) {
        return
      }

      const selectedDraftShotId =
        input.shotIndex === undefined
          ? getSelectedCanvasVideoDraftShotId(draftShotIds, activeShotId)
          : undefined
      const shotIndex =
        input.shotIndex ??
        (selectedDraftShotId
          ? getCanvasVideoDraftShotIndex({
              draftShotId: selectedDraftShotId,
              draftShotIds,
              tasks,
            })
          : getNextCanvasVideoShotIndex(tasks))

      setIsSubmitting(true)

      try {
        const submission = await submitProjectVideoGeneration(projectId, {
          aspectRatio: input.aspectRatio,
          model: input.model,
          prompt: input.prompt,
          referenceAudios: input.referenceAudios,
          referenceImages: input.referenceImages,
          referenceVideos: input.referenceVideos,
          seconds: input.seconds,
          shotIndex,
        })
        const generationRecord = producerGenerationRecordFromSubmission(submission)

        mergeLocalGenerationRecords([generationRecord])
        setActiveShotId(`canvas-video-storyboard-shot:${submission.generation.id}`)
        if (selectedDraftShotId) {
          setDraftShotIds((currentDraftShotIds) =>
            currentDraftShotIds.filter(
              (currentDraftShotId) => currentDraftShotId !== selectedDraftShotId,
            ),
          )
          setDraftShotMediaById((currentMediaById) => {
            const { [selectedDraftShotId]: _removedMedia, ...nextMediaById } = currentMediaById

            return nextMediaById
          })
        }
      } finally {
        setIsSubmitting(false)
      }
    },
    [activeShotId, draftShotIds, isSubmitting, mergeLocalGenerationRecords, projectId, tasks],
  )

  if (generationRecordsError) {
    throw generationRecordsError
  }

  if (isGenerationRecordsInitialLoadPending) {
    return <RouteBootShell variant="project" />
  }

  if (assetRecordsError) {
    throw assetRecordsError
  }

  return (
    <ProjectWorkspaceProviders projectId={projectId}>
      <ProjectCanvasLayoutCoordinator
        key={projectId}
        projectId={projectId}
        workspaceNodes={storyboardNodes}
      >
        <div
          className="project-workspace relative h-svh max-h-svh overflow-hidden"
          data-canvas-video-workspace="true"
          data-canvas-video-next-shot-index={nextShotIndex}
        >
          <ProjectMouseGlow />

          <header className="layer-header pointer-events-auto absolute inset-x-0 top-0">
            <div className="relative flex h-[var(--layout-project-header-height)] w-full items-center justify-between text-[var(--color-on-background)]">
              <div className="relative flex h-full w-full items-center justify-between gap-4 bg-transparent pt-4 pr-[var(--layout-project-header-inline-end)] pb-4 pl-[var(--layout-project-header-inline-start)]">
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <ProjectHeaderLeft />
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  <ProjectHeaderRight />
                </div>
              </div>
            </div>
          </header>

          <main className="absolute inset-0 flex overflow-hidden">
            <ProjectCanvasStage
              composerSlot={
                <CanvasVideoComposer
                  appendFilesInput={composerAppendFilesInput}
                  draftInput={composerDraftInput}
                  focusRequestId={composerFocusRequestId}
                  isSubmitting={isSubmitting}
                  onSubmit={handleSubmit}
                />
              }
              enableCanvasViewportZoom
              extraCanvasNodeTypes={CANVAS_VIDEO_STORYBOARD_NODE_TYPES}
              showComposer
              showFocusedArtifact={false}
              showOutputPanel={false}
              showProjectNodes={false}
            />
          </main>
        </div>
      </ProjectCanvasLayoutCoordinator>
    </ProjectWorkspaceProviders>
  )
}
