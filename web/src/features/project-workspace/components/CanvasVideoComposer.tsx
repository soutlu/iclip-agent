import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { splitVideoGenerationReferenceUrls } from '@/features/projects'
import {
  type ComposerFileAttachment,
  ComposerMediaStack,
  createEmptyMediaComposerDraft,
  createMediaComposerDocumentFromText,
  createMediaComposerSubmission,
  hasMediaComposerText,
  isComposerMediaWithinLimits,
  normalizeComposerAttachmentNamesByOrder,
  MediaComposerEditor,
  prepareComposerAttachmentsForSubmission,
  removeMediaComposerAttachment,
  reorderMediaComposerAttachments,
  revokeComposerAttachmentObjectUrls,
  revokeRemovedComposerAttachmentObjectUrls,
  useComposerFileDropZone,
  useComposerFileIngress,
} from '@/shared/composer'
import ComposerShell from '@/shared/composer/ComposerShell'
import VideoGenerationSettingsControl, {
  clampVideoGenerationSeconds,
  closestVideoGenerationAspectRatio,
  DEFAULT_VIDEO_GENERATION_SETTINGS,
  type VideoGenerationAspectRatio,
  type VideoGenerationSettings,
  VideoGenerationSettingsSummary,
} from '@/shared/composer/VideoGenerationSettingsControl'
import { cn } from '@/shared/lib/utils'
import {
  composerAttachmentToPreviewItem,
  mediaComposerReferenceToPreviewItem,
  MediaPreviewDialog,
  useMediaPreview,
} from '@/shared/ui/media'

export interface CanvasVideoComposerSubmitInput {
  aspectRatio: string
  model: string
  prompt: string
  referenceAudios: string[]
  referenceImages: string[]
  referenceVideos: string[]
  seconds: number
  shotIndex?: number
}

export interface CanvasVideoComposerDraftInput {
  aspectRatio?: VideoGenerationAspectRatio
  files?: ComposerFileAttachment[]
  prompt: string
  requestId: number
  seconds?: number
  shotIndex?: number
}

export interface CanvasVideoComposerAppendFilesInput {
  files: ComposerFileAttachment[]
  requestId: number
}

interface CanvasVideoComposerProps {
  appendFilesInput?: CanvasVideoComposerAppendFilesInput
  draftInput?: CanvasVideoComposerDraftInput
  focusRequestId?: number
  isSubmitting: boolean
  onSubmit: (input: CanvasVideoComposerSubmitInput) => Promise<void>
}

const EMPTY_CANVAS_MEDIA_NAME_SEEDS: Array<Pick<ComposerFileAttachment, 'kind' | 'name'>> = []

/**
 * 渲染 Direct Canvas 视频生成输入框。
 *
 * @param props - Canvas 视频输入框属性。
 * @param props.draftInput - 外部工具写入的输入框草稿。
 * @param props.focusRequestId - 外部请求聚焦输入框的递增序号。
 * @param props.isSubmitting - 当前是否正在提交视频生成任务。
 * @param props.onSubmit - 已完成附件上传和媒体拆分后的提交回调。
 * @returns 不含模式选择、不写入 Agent composer store 的 Canvas 输入框。
 */
export default function CanvasVideoComposer({
  appendFilesInput,
  draftInput,
  focusRequestId = 0,
  isSubmitting,
  onSubmit,
}: CanvasVideoComposerProps) {
  const [attachmentErrorMessage, setAttachmentErrorMessage] = useState<string | undefined>(
    undefined,
  )
  const [draft, setDraft] = useState(createEmptyMediaComposerDraft)
  const [isPreparingSubmission, setIsPreparingSubmission] = useState(false)
  const [pendingUploadCount, setPendingUploadCount] = useState(0)
  const [requestErrorMessage, setRequestErrorMessage] = useState<string | undefined>(undefined)
  const [redoShotIndex, setRedoShotIndex] = useState<number | undefined>(undefined)
  const [videoSettings, setVideoSettings] = useState<VideoGenerationSettings>(
    DEFAULT_VIDEO_GENERATION_SETTINGS,
  )
  const filesRef = useRef<ComposerFileAttachment[]>([])
  const lastAppendFilesRequestIdRef = useRef<number | undefined>(undefined)
  const submitLockRef = useRef(false)
  const { closePreview, openPreview, preview } = useMediaPreview()
  const isComposerLocked = isSubmitting || isPreparingSubmission
  const files = draft.attachments
  const firstImageAttachment = useMemo(
    () => files.find((file) => file.kind === 'image') ?? null,
    [files],
  )

  /**
   * 追加本地选择或拖入的附件。
   *
   * @param nextFiles - 附件处理工具返回的可预览附件。
   * @returns 无返回值。
   */
  const addFiles = useCallback((nextFiles: ComposerFileAttachment[]) => {
    setDraft((currentDraft) => ({
      ...currentDraft,
      attachments: [...currentDraft.attachments, ...nextFiles],
    }))
  }, [])

  /**
   * 调整正在处理的附件计数。
   *
   * @param delta - 需要增加或减少的计数。
   * @returns 无返回值。
   */
  const adjustPendingUploadCount = useCallback((delta: number) => {
    setPendingUploadCount((currentCount) => Math.max(0, currentCount + delta))
  }, [])

  /**
   * 清理附件处理错误。
   *
   * @returns 无返回值。
   */
  const clearAttachmentErrorMessage = useCallback(() => {
    setAttachmentErrorMessage(undefined)
  }, [])

  const handleFilesSelected = useComposerFileIngress({
    addFiles,
    adjustPendingUploadCount,
    clearAttachmentErrorMessage,
    files,
    mediaNameSeeds: EMPTY_CANVAS_MEDIA_NAME_SEEDS,
    setAttachmentErrorMessage,
  })
  const dropZoneProps = useComposerFileDropZone({
    disabled: isComposerLocked,
    onFilesSelected: handleFilesSelected,
  })

  /**
   * 从 Canvas 输入框移除一个附件。
   *
   * @param attachmentId - 需要移除的附件 id。
   * @returns 无返回值。
   */
  const removeFile = useCallback(
    (attachmentId: string) => {
      if (preview?.attachmentId === attachmentId) {
        closePreview()
      }

      setDraft((currentDraft) => {
        const nextDraft = removeMediaComposerAttachment(currentDraft, attachmentId)

        revokeRemovedComposerAttachmentObjectUrls(currentDraft.attachments, nextDraft.attachments)
        return nextDraft
      })
    },
    [closePreview, preview?.attachmentId],
  )

  /**
   * 调整附件栈排序。
   *
   * @param activeId - 被拖拽的附件 id。
   * @param overId - 目标位置附件 id。
   * @returns 无返回值。
   */
  const reorderFiles = useCallback((activeId: string, overId: string) => {
    setDraft((currentDraft) => reorderMediaComposerAttachments(currentDraft, activeId, overId))
  }, [])

  /**
   * 提交 Canvas 视频生成任务。
   *
   * @returns 无返回值；失败时恢复当前草稿并显示错误。
   */
  const handleSubmit = useCallback(async () => {
    let submission

    try {
      submission = createMediaComposerSubmission({ draft, libraryMedia: [] })
    } catch (error) {
      setRequestErrorMessage(error instanceof Error ? error.message : String(error))
      return
    }

    const { attachments: currentFiles, prompt } = submission

    if (pendingUploadCount > 0 || isComposerLocked || submitLockRef.current) {
      return
    }

    submitLockRef.current = true
    setIsPreparingSubmission(true)
    setAttachmentErrorMessage(undefined)
    setRequestErrorMessage(undefined)

    try {
      const { fileParts } = await prepareComposerAttachmentsForSubmission(currentFiles)
      const { referenceAudios, referenceImages, referenceVideos } =
        splitVideoGenerationReferenceUrls(fileParts)

      await onSubmit({
        aspectRatio: videoSettings.aspectRatio,
        model: videoSettings.model,
        prompt,
        referenceAudios,
        referenceImages,
        referenceVideos,
        seconds: videoSettings.seconds,
        ...(redoShotIndex === undefined ? {} : { shotIndex: redoShotIndex }),
      })
      closePreview()
      revokeComposerAttachmentObjectUrls(currentFiles)
      setDraft(createEmptyMediaComposerDraft())
      setRedoShotIndex(undefined)
    } catch (error) {
      setRequestErrorMessage(error instanceof Error ? error.message : String(error))
    } finally {
      submitLockRef.current = false
      setIsPreparingSubmission(false)
    }
  }, [
    closePreview,
    draft,
    isComposerLocked,
    onSubmit,
    pendingUploadCount,
    redoShotIndex,
    videoSettings.aspectRatio,
    videoSettings.model,
    videoSettings.seconds,
  ])

  useEffect(() => {
    filesRef.current = files
  }, [files])

  useEffect(() => {
    const firstImageUrl = firstImageAttachment?.url.trim()

    if (!firstImageUrl) {
      return undefined
    }

    let cancelled = false
    const image = new Image()
    const imageName = firstImageAttachment?.name.trim() || '第一张图片'

    image.onload = () => {
      if (cancelled) {
        return
      }

      try {
        const width = image.naturalWidth || image.width
        const height = image.naturalHeight || image.height
        const aspectRatio = closestVideoGenerationAspectRatio(width, height)

        setVideoSettings((currentSettings) => ({
          ...currentSettings,
          aspectRatio,
        }))
      } catch (error) {
        setAttachmentErrorMessage(
          `${imageName} 无法读取有效图片比例：${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    image.onerror = () => {
      if (!cancelled) {
        setAttachmentErrorMessage(`${imageName} 无法读取图片比例。`)
      }
    }
    image.src = firstImageUrl

    return () => {
      cancelled = true
      image.onload = null
      image.onerror = null
    }
  }, [firstImageAttachment?.name, firstImageAttachment?.url])

  useEffect(() => {
    if (!appendFilesInput || lastAppendFilesRequestIdRef.current === appendFilesInput.requestId) {
      return
    }

    lastAppendFilesRequestIdRef.current = appendFilesInput.requestId

    if (appendFilesInput.files.length === 0) {
      return
    }

    setDraft((currentDraft) => ({
      ...currentDraft,
      attachments: normalizeComposerAttachmentNamesByOrder([
        ...currentDraft.attachments,
        ...appendFilesInput.files,
      ]),
    }))
  }, [appendFilesInput])

  useEffect(() => {
    if (!draftInput) {
      return
    }

    closePreview()
    setAttachmentErrorMessage(undefined)
    setRequestErrorMessage(undefined)
    setRedoShotIndex(draftInput.shotIndex)
    setDraft((currentDraft) => {
      revokeComposerAttachmentObjectUrls(currentDraft.attachments)
      return {
        attachments: normalizeComposerAttachmentNamesByOrder(draftInput.files ?? []),
        document: createMediaComposerDocumentFromText(draftInput.prompt),
      }
    })
    setVideoSettings((currentSettings) => ({
      ...currentSettings,
      aspectRatio: draftInput.aspectRatio ?? currentSettings.aspectRatio,
      seconds:
        typeof draftInput.seconds === 'number'
          ? clampVideoGenerationSeconds(draftInput.seconds)
          : currentSettings.seconds,
    }))
  }, [closePreview, draftInput])

  useEffect(
    () => () => {
      revokeComposerAttachmentObjectUrls(filesRef.current)
    },
    [],
  )

  const submitDisabled =
    !hasMediaComposerText(draft.document) ||
    pendingUploadCount > 0 ||
    isComposerLocked ||
    !isComposerMediaWithinLimits(files)
  const submitLabel = '发送'
  const showGenerationSettingsSummary = firstImageAttachment !== null

  return (
    <div className="relative w-full md:w-fit" data-canvas-video-composer="true">
      <ComposerShell
        className="layer-local-1 relative flex w-full flex-col justify-end overflow-visible text-on-background md:w-[68vw] md:max-w-[920px] md:min-w-[720px]"
        dropHint="拖拽图片、视频或音频到这里"
        isDropActive={dropZoneProps.isDragActive}
        onDragEnter={dropZoneProps.onDragEnter}
        onDragLeave={dropZoneProps.onDragLeave}
        onDragOver={dropZoneProps.onDragOver}
        onDrop={dropZoneProps.onDrop}
        onDropCapture={dropZoneProps.onDropCapture}
      >
        <div className="relative flex flex-col px-5 pt-4 pb-4 text-body leading-[1.6]">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:gap-3">
            <ComposerMediaStack
              disabled={isComposerLocked}
              attachments={files}
              onFilesSelected={handleFilesSelected}
              onOpenPreview={(attachment) =>
                openPreview(composerAttachmentToPreviewItem(attachment))
              }
              onReorderMedia={reorderFiles}
              onRemoveMedia={removeFile}
            />

            <div className="relative min-w-0 flex-1">
              <MediaComposerEditor
                ariaLabel="Canvas 视频生成输入框"
                attachments={files}
                className="min-h-[5rem] text-body leading-[1.6] whitespace-pre-wrap md:min-h-[6rem]"
                disabled={isComposerLocked}
                document={draft.document}
                focusRequestKey={focusRequestId}
                onDocumentChange={(document) => {
                  setDraft((currentDraft) => ({ ...currentDraft, document }))
                }}
                onFilesSelected={handleFilesSelected}
                onOpenMediaPreview={(reference) =>
                  openPreview(mediaComposerReferenceToPreviewItem(reference))
                }
                onSubmitRequest={() => {
                  void handleSubmit()
                }}
              />
            </div>
          </div>

          {pendingUploadCount > 0 ? (
            <div
              className="mt-3 rounded-lg border border-border bg-control-bg px-3 py-2 text-label text-on-background"
              role="status"
            >
              处理中，正在准备 {pendingUploadCount.toString()} 个媒体文件
            </div>
          ) : null}

          {attachmentErrorMessage ? (
            <div
              className="mt-3 rounded-lg border border-danger-border bg-danger-bg px-3 py-2 text-label leading-5 text-danger-text"
              role="alert"
            >
              {attachmentErrorMessage}
            </div>
          ) : null}

          {requestErrorMessage ? (
            <div
              className="mt-3 rounded-lg border border-danger-border bg-danger-bg px-3 py-2 text-label leading-5 text-danger-text"
              role="alert"
            >
              {requestErrorMessage}
            </div>
          ) : null}

          <div className="flex shrink-0 items-center gap-2 pt-5">
            <VideoGenerationSettingsControl
              panelAlign="top-start"
              settings={videoSettings}
              onSettingsChange={setVideoSettings}
            />

            {showGenerationSettingsSummary ? (
              <VideoGenerationSettingsSummary
                data-canvas-video-settings-summary="true"
                settings={videoSettings}
              />
            ) : null}

            <span className="flex-1" />

            <button
              type="button"
              disabled={submitDisabled}
              className={cn(
                'hit-48 relative flex h-8 w-8 items-center justify-center rounded-full transition-all duration-[var(--dur-s)] ease-[var(--ease)]',
                submitDisabled
                  ? 'cursor-not-allowed border-none bg-transparent text-disabled-text'
                  : 'cursor-pointer bg-on-background text-background hover:scale-105 active:scale-95',
              )}
              aria-label={submitLabel}
              onClick={() => {
                void handleSubmit()
              }}
            >
              <svg
                aria-hidden="true"
                width="16"
                height="16"
                fill="currentColor"
                viewBox="0 0 256 256"
              >
                <title>{submitLabel}</title>
                <path d="M208.49,120.49a12,12,0,0,1-17,0L140,69V216a12,12,0,0,1-24,0V69L64.49,120.49a12,12,0,0,1-17-17l72-72a12,12,0,0,1,17,0l72,72A12,12,0,0,1,208.49,120.49Z" />
              </svg>
            </button>
          </div>
        </div>
      </ComposerShell>

      {preview ? (
        <MediaPreviewDialog
          key={`${preview.mediaType}:${preview.attachmentId ?? preview.url}`}
          onClose={closePreview}
          preview={preview}
        />
      ) : null}
    </div>
  )
}
