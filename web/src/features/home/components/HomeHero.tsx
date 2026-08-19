import { useNavigate } from '@tanstack/react-router'
import { type ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
// 豁免：只取跨页草稿暂存模块，避免经 chat barrel 将整个聊天栈拉进首页共享 chunk（bundle 体积豁免，见边界治理报告）。
// eslint-disable-next-line boundaries/dependencies
import { storeProjectPendingDraft } from '@/features/chat/lib/project-pending-draft'
import {
  HOME_COMPOSER_MODES,
  HOME_DEFAULT_COMPOSER_MODE,
  HOME_HERO_TITLE,
} from '@/features/home/utils/create-home.constants'
import {
  createProducerProject,
  createProducerProjectSession,
  type CreateProducerProjectInput,
  splitVideoGenerationReferenceUrls,
  storePreferredProducerProjectSessionId,
  submitProjectVideoGeneration,
} from '@/features/projects'
import {
  collectReferencedComposerAttachmentIds,
  COMPOSER_MEDIA_FILE_ACCEPT,
  type ComposerFileAttachment,
  ComposerMediaStack,
  createEmptyMediaComposerDraft,
  createMediaComposerSubmission,
  hasMediaComposerText,
  isComposerMediaWithinLimits,
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
  closestVideoGenerationAspectRatio,
  DEFAULT_VIDEO_GENERATION_SETTINGS,
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

type HomeComposerModeValue = (typeof HOME_COMPOSER_MODES)[number]['value']

const EMPTY_HOME_MEDIA_NAME_SEEDS: Array<Pick<ComposerFileAttachment, 'kind' | 'name'>> = []

function VideoModeIcon() {
  return (
    <svg aria-hidden="true" width="20" height="20" viewBox="0 0 20 20" fill="none">
      <path
        d="M5.833 5.77A1.35 1.35 0 0 1 7.9 4.623l6.77 4.231a1.35 1.35 0 0 1 0 2.29l-6.77 4.23a1.35 1.35 0 0 1-2.066-1.144V5.769Z"
        fill="currentColor"
      />
    </svg>
  )
}

// Agent 模式的星火图标：与 VideoModeIcon 同为 20 网格填充图标，保持模式切换视觉同源。
function AgentModeIcon() {
  return (
    <svg aria-hidden="true" width="20" height="20" viewBox="0 0 20 20" fill="none">
      <path
        d="M10 1.6 11.9 8.1 18.4 10 11.9 11.9 10 18.4 8.1 11.9 1.6 10 8.1 8.1 10 1.6Z"
        fill="currentColor"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function HomeComposerModeIcon({ mode }: { mode: HomeComposerModeValue }) {
  if (mode === 'video') {
    return <VideoModeIcon />
  }

  return <AgentModeIcon />
}

/**
 * 将首页模式转换成后端项目类型。
 *
 * @param mode - 首页当前选择的创作模式。
 * @returns 创建项目时使用的项目类型。
 */
const homeModeToProjectInput = (mode: HomeComposerModeValue): CreateProducerProjectInput =>
  mode === 'agent' ? { kind: 'agent' } : { kind: 'direct' }

/**
 * 渲染首页 Hero 工作区启动器。
 *
 * @returns 只负责创建 workspace 并导航到项目页的首页输入框外观。
 */
export default function HomeHero() {
  const navigate = useNavigate()
  const [activeMode, setActiveMode] = useState<HomeComposerModeValue>(HOME_DEFAULT_COMPOSER_MODE)
  const [attachmentErrorMessage, setAttachmentErrorMessage] = useState<string | undefined>(
    undefined,
  )
  const [draft, setDraft] = useState(createEmptyMediaComposerDraft)
  const [errorMessage, setErrorMessage] = useState<null | string>(null)
  const [isModeMenuOpen, setIsModeMenuOpen] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [pendingUploadCount, setPendingUploadCount] = useState(0)
  const [videoSettings, setVideoSettings] = useState<VideoGenerationSettings>(
    DEFAULT_VIDEO_GENERATION_SETTINGS,
  )
  const filesRef = useRef<ComposerFileAttachment[]>([])
  const submitLockRef = useRef(false)
  const uploadInputRef = useRef<HTMLInputElement>(null)
  const { closePreview, openPreview, preview } = useMediaPreview()
  const files = draft.attachments
  const activeModeLabel =
    HOME_COMPOSER_MODES.find((mode) => mode.value === activeMode)?.label ?? 'Video'
  const firstImageAttachment = useMemo(
    () => files.find((file) => file.kind === 'image') ?? null,
    [files],
  )
  // agent 模式聊天只发送被 @ 引用的媒体，暂存区区分两态；
  // video 模式维持「卡片即载荷」全发送语义，不做灰显。
  const referencedAttachmentIds = useMemo(
    () =>
      activeMode === 'video' ? undefined : collectReferencedComposerAttachmentIds(draft.document),
    [activeMode, draft.document],
  )

  /**
   * 追加首页选择或拖入的附件。
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
   * 调整首页附件处理计数。
   *
   * @param delta - 需要增加或减少的计数。
   * @returns 无返回值。
   */
  const adjustPendingUploadCount = useCallback((delta: number) => {
    setPendingUploadCount((currentCount) => Math.max(0, currentCount + delta))
  }, [])

  /**
   * 清理首页附件错误。
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
    mediaNameSeeds: EMPTY_HOME_MEDIA_NAME_SEEDS,
    setAttachmentErrorMessage,
  })
  const dropZoneProps = useComposerFileDropZone({
    disabled: isSubmitting,
    onFilesSelected: handleFilesSelected,
  })

  const handleUploadInputChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const selectedFiles = Array.from(event.currentTarget.files ?? [])
      event.currentTarget.value = ''

      if (selectedFiles.length === 0) {
        return
      }

      handleFilesSelected(selectedFiles)
    },
    [handleFilesSelected],
  )

  /**
   * 移除首页草稿中的附件。
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
   * 调整首页附件栈排序。
   *
   * @param activeId - 被拖拽附件 id。
   * @param overId - 目标附件 id。
   * @returns 无返回值。
   */
  const reorderFiles = useCallback((activeId: string, overId: string) => {
    setDraft((currentDraft) => reorderMediaComposerAttachments(currentDraft, activeId, overId))
  }, [])

  /**
   * 创建当前模式对应的项目并进入统一项目页。
   *
   * @returns 无返回值；创建失败时只在首页显示错误。
   */
  const handleLaunchWorkspace = async () => {
    let submission

    try {
      submission = createMediaComposerSubmission({ draft, libraryMedia: [] })
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error))
      return
    }

    const { attachments: currentFiles, prompt } = submission

    if (pendingUploadCount > 0 || isSubmitting || submitLockRef.current) {
      return
    }

    submitLockRef.current = true
    setAttachmentErrorMessage(undefined)
    setErrorMessage(null)
    setIsSubmitting(true)

    try {
      const { fileParts, remoteAttachments } =
        await prepareComposerAttachmentsForSubmission(currentFiles)
      const project = await createProducerProject(homeModeToProjectInput(activeMode))

      if (activeMode === 'video') {
        const { referenceAudios, referenceImages, referenceVideos } =
          splitVideoGenerationReferenceUrls(fileParts)

        await submitProjectVideoGeneration(project.id, {
          aspectRatio: videoSettings.aspectRatio,
          model: videoSettings.model,
          prompt,
          referenceAudios,
          referenceImages,
          referenceVideos,
          seconds: videoSettings.seconds,
          shotIndex: 1,
        })
      } else {
        const session = await createProducerProjectSession(project.id)

        storePreferredProducerProjectSessionId(project.id, session.id)
        storeProjectPendingDraft(project.id, session.id, {
          attachments: remoteAttachments,
          document: draft.document,
        })
      }

      closePreview()
      revokeComposerAttachmentObjectUrls(currentFiles)
      setDraft(createEmptyMediaComposerDraft())
      void navigate({ params: { projectId: project.id }, to: '/projects/$projectId' })
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error))
    } finally {
      submitLockRef.current = false
      setIsSubmitting(false)
    }
  }

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

  useEffect(
    () => () => {
      revokeComposerAttachmentObjectUrls(filesRef.current)
    },
    [],
  )

  const submitDisabled =
    !hasMediaComposerText(draft.document) ||
    pendingUploadCount > 0 ||
    isSubmitting ||
    !isComposerMediaWithinLimits(files)
  const submitLabel = '发送'
  const showGenerationSettingsSummary = activeMode === 'video' && files.length > 0

  return (
    <section className="mx-auto w-full max-w-[var(--layout-home-hero-max)] text-center">
      <div className="mx-auto max-w-[var(--layout-home-title-max)]">
        <h1 className="home-title text-center">{HOME_HERO_TITLE}</h1>
      </div>

      <div
        className={cn(
          'home-quick-start-enter home-composer-entry',
          isModeMenuOpen ? 'home-composer-entry--open' : '',
        )}
      >
        <ComposerShell
          className="home-composer-panel group layer-local-1 relative flex w-full flex-col justify-end overflow-visible transition-[box-shadow,border-color] duration-150 ease-out"
          dropHint="拖拽图片、视频或音频到这里"
          isDropActive={dropZoneProps.isDragActive}
          onDragEnter={dropZoneProps.onDragEnter}
          onDragLeave={dropZoneProps.onDragLeave}
          onDragOver={dropZoneProps.onDragOver}
          onDrop={dropZoneProps.onDrop}
          onDropCapture={dropZoneProps.onDropCapture}
          style={{ transform: 'rotate(-0.25deg)', transformOrigin: 'left center' }}
        >
          <span className="relative flex flex-col px-5 pt-3 pb-3 text-sm leading-[1.6]">
            <span className="relative flex min-h-[4rem]">
              <input
                ref={uploadInputRef}
                type="file"
                accept={COMPOSER_MEDIA_FILE_ACCEPT}
                disabled={isSubmitting}
                multiple
                className={files.length === 0 ? 'home-composer-upload-input' : 'hidden'}
                aria-label="上传参考图片、视频或音频"
                onChange={handleUploadInputChange}
              />

              {files.length === 0 ? (
                <span
                  className="home-composer-upload-card"
                  aria-hidden="true"
                  title="上传参考图片、视频或音频"
                >
                  <svg
                    aria-hidden="true"
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                  >
                    <title>上传参考图片、视频或音频</title>
                    <path d="M10.8 20a1.2 1.2 0 0 0 2.4 0v-6.8H20a1.2 1.2 0 1 0 0-2.4h-6.8V4a1.2 1.2 0 0 0-2.4 0v6.8H4a1.2 1.2 0 0 0 0 2.4h6.8V20Z" />
                  </svg>
                </span>
              ) : (
                <span className="home-composer-upload-stack">
                  <ComposerMediaStack
                    disabled={isSubmitting}
                    attachments={files}
                    onFilesSelected={handleFilesSelected}
                    onOpenPreview={(attachment) =>
                      openPreview(composerAttachmentToPreviewItem(attachment))
                    }
                    onReorderMedia={reorderFiles}
                    onRemoveMedia={removeFile}
                    referencedAttachmentIds={referencedAttachmentIds}
                  />
                </span>
              )}

              <span className="chat-tiptap-v3 home-composer-input-area relative flex w-full">
                <MediaComposerEditor
                  ariaLabel="首页创作输入框"
                  attachments={files}
                  className="min-h-[4rem] w-full text-body leading-[1.6] whitespace-pre-wrap"
                  disabled={isSubmitting}
                  document={draft.document}
                  onDocumentChange={(document) => {
                    setDraft((currentDraft) => ({ ...currentDraft, document }))
                  }}
                  onFilesSelected={handleFilesSelected}
                  onOpenMediaPreview={(reference) =>
                    openPreview(mediaComposerReferenceToPreviewItem(reference))
                  }
                  onSubmitRequest={() => {
                    void handleLaunchWorkspace()
                  }}
                />
              </span>
            </span>

            <span className="flex shrink-0 items-center gap-2 pt-4">
              <span className="home-composer-mode-switch">
                <button
                  type="button"
                  className="home-composer-mode-trigger"
                  aria-controls={isModeMenuOpen ? 'home-composer-mode-popover' : undefined}
                  aria-expanded={isModeMenuOpen}
                  aria-haspopup="menu"
                  aria-label="切换创作模式"
                  onClick={() => setIsModeMenuOpen((current) => !current)}
                >
                  <span className="home-composer-mode-trigger-main">
                    <HomeComposerModeIcon mode={activeMode} />
                    <span className="home-composer-mode-label">{activeModeLabel}</span>
                  </span>
                  <svg
                    aria-hidden="true"
                    className="home-composer-mode-chevron"
                    width="14"
                    height="14"
                    viewBox="0 0 16 16"
                    fill="none"
                  >
                    <path
                      d="m4 6 4 4 4-4"
                      stroke="currentColor"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="2"
                    />
                  </svg>
                </button>
              </span>

              {activeMode === 'video' ? (
                <VideoGenerationSettingsControl
                  panelAlign="bottom-start"
                  settings={videoSettings}
                  onOpenChange={(open) => {
                    if (open) {
                      setIsModeMenuOpen(false)
                    }
                  }}
                  onSettingsChange={setVideoSettings}
                />
              ) : null}

              {showGenerationSettingsSummary ? (
                <VideoGenerationSettingsSummary
                  data-home-video-settings-summary="true"
                  settings={videoSettings}
                />
              ) : null}

              <span className="flex-1" />

              <button
                type="button"
                aria-label={submitLabel}
                className="home-composer-send hit-48 relative flex h-8 w-8 items-center justify-center rounded-full shadow-sm transition-all duration-150 ease-out group-hover:scale-105 group-active:scale-95"
                disabled={submitDisabled}
                onClick={() => {
                  void handleLaunchWorkspace()
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
            </span>

            {pendingUploadCount > 0 ? (
              <span
                className="mt-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-control-bg)] px-3 py-2 text-left text-label leading-5 text-[var(--color-on-background)]"
                role="status"
              >
                处理中，正在准备 {pendingUploadCount.toString()} 个媒体文件
              </span>
            ) : null}

            {attachmentErrorMessage ? (
              <span
                className="mt-3 rounded-lg border border-[var(--color-danger-border)] bg-[var(--color-danger-bg)] px-3 py-2 text-left text-label leading-5 text-[var(--color-danger-text)]"
                role="alert"
              >
                {attachmentErrorMessage}
              </span>
            ) : null}

            {errorMessage ? (
              <span
                className="mt-3 rounded-lg border border-[var(--color-danger-border)] bg-[var(--color-danger-bg)] px-3 py-2 text-left text-label leading-5 text-[var(--color-danger-text)]"
                role="alert"
              >
                {errorMessage}
              </span>
            ) : null}
          </span>
        </ComposerShell>

        {isModeMenuOpen ? (
          <span className="home-composer-mode-popover" id="home-composer-mode-popover" role="menu">
            <span className="home-composer-mode-popover-title">Creation mode</span>
            {HOME_COMPOSER_MODES.map((mode) => {
              const isActive = mode.value === activeMode

              return (
                <button
                  key={mode.value}
                  type="button"
                  className="home-composer-mode-menu-option"
                  aria-checked={isActive}
                  role="menuitemradio"
                  onClick={() => {
                    setActiveMode(mode.value)
                    setIsModeMenuOpen(false)
                  }}
                >
                  <span className="home-composer-mode-menu-option-icon">
                    <HomeComposerModeIcon mode={mode.value} />
                  </span>
                  <span>{mode.label}</span>
                  {isActive ? (
                    <svg
                      className="home-composer-mode-check"
                      aria-hidden="true"
                      width="20"
                      height="20"
                      viewBox="0 0 20 20"
                      fill="none"
                    >
                      <path
                        d="m4.5 10.35 3.15 3.15 7.85-8"
                        stroke="currentColor"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="2"
                      />
                    </svg>
                  ) : null}
                </button>
              )
            })}
          </span>
        ) : null}
      </div>

      {preview ? (
        <MediaPreviewDialog
          key={`${preview.mediaType}:${preview.attachmentId ?? preview.url}`}
          onClose={closePreview}
          preview={preview}
        />
      ) : null}
    </section>
  )
}
