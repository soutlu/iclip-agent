import { useCallback, useEffect, useMemo } from 'react'
import ProjectComposerToolbar from '@/features/chat/components/composer/ProjectComposerToolbar'
import { useProjectComposerStore } from '@/features/chat/state/project-composer-store'
import {
  collectReferencedComposerAttachmentIds,
  ComposerMediaStack,
  hasMediaComposerText,
  isComposerMediaWithinLimits,
  MediaComposerEditor,
  useComposerFileDropZone,
  useComposerFileIngress,
} from '@/shared/composer'
import ComposerShell from '@/shared/composer/ComposerShell'
import { useBreakpoint } from '@/shared/hooks/useBreakpoint'
import {
  composerAttachmentToPreviewItem,
  mediaComposerReferenceToPreviewItem,
  MediaPreviewDialog,
  useMediaPreview,
} from '@/shared/ui/media'
import { WAITING_FOR_CONTINUATION_REQUEST_ERROR_MESSAGE } from '../../lib/project-chat-error'
import { producerProjectMediaToMediaComposerLibraryMedia } from '../../runtime/project-state.adapters'
import { useProjectChatComposer } from '../../state/ProjectChatProvider'

interface ProjectComposerProps {
  embedded?: boolean
}

/**
 * 渲染项目聊天输入框、媒体附件栈和已登记项目媒体引用入口。
 *
 * @param props - composer 展示属性。
 * @param props.embedded - 是否嵌入在聊天面板底部。
 * @returns 项目聊天 composer 组件。
 */
export default function ProjectComposer({ embedded = false }: ProjectComposerProps) {
  const isDesktop = useBreakpoint('md')
  const addAttachments = useProjectComposerStore((s) => s.addAttachments)
  const adjustPendingUploadCount = useProjectComposerStore((s) => s.adjustPendingUploadCount)
  const attachmentErrorMessage = useProjectComposerStore((s) => s.attachmentErrorMessage)
  const clearAttachmentErrorMessage = useProjectComposerStore((s) => s.clearAttachmentErrorMessage)
  const clearRequestErrorMessage = useProjectComposerStore((s) => s.clearRequestErrorMessage)
  const attachments = useProjectComposerStore((s) => s.attachments)
  const document = useProjectComposerStore((s) => s.document)
  const focusRequestKey = useProjectComposerStore((s) => s.focusRequestKey)
  const pendingUploadCount = useProjectComposerStore((s) => s.pendingUploadCount)
  const reorderAttachments = useProjectComposerStore((s) => s.reorderAttachments)
  const removeAttachment = useProjectComposerStore((s) => s.removeAttachment)
  const requestErrorMessage = useProjectComposerStore((s) => s.requestErrorMessage)
  const setAttachmentErrorMessage = useProjectComposerStore((s) => s.setAttachmentErrorMessage)
  const setDocument = useProjectComposerStore((s) => s.setDocument)
  const {
    activeInterrupt,
    isInteractionLocked,
    projectMedia,
    submitDraft: submitProjectDraft,
  } = useProjectChatComposer()
  const { closePreview, openPreview, preview } = useMediaPreview()
  const referencedAttachmentIds = useMemo(
    () => collectReferencedComposerAttachmentIds(document),
    [document],
  )
  const libraryMedia = useMemo(
    () => projectMedia.map(producerProjectMediaToMediaComposerLibraryMedia),
    [projectMedia],
  )
  const mediaNameSeeds = useMemo(
    () => libraryMedia.map(({ kind, promptKey }) => ({ kind, name: promptKey })),
    [libraryMedia],
  )
  const ingestFiles = useComposerFileIngress({
    addFiles: addAttachments,
    adjustPendingUploadCount,
    clearAttachmentErrorMessage,
    files: attachments,
    mediaNameSeeds,
    setAttachmentErrorMessage,
  })
  const dropZoneProps = useComposerFileDropZone({
    disabled: isInteractionLocked,
    onFilesSelected: ingestFiles,
  })
  const waitingForContinuation = activeInterrupt !== null
  const submitDisabled =
    !hasMediaComposerText(document) ||
    isInteractionLocked ||
    pendingUploadCount > 0 ||
    waitingForContinuation ||
    !isComposerMediaWithinLimits(attachments)
  const visibleRequestErrorMessage =
    requestErrorMessage === WAITING_FOR_CONTINUATION_REQUEST_ERROR_MESSAGE
      ? undefined
      : requestErrorMessage

  const handleSubmitDraft = () => {
    if (pendingUploadCount > 0 || isInteractionLocked || waitingForContinuation) {
      return
    }

    closePreview()
    void submitProjectDraft({ attachments, document })
  }

  useEffect(() => {
    if (
      !waitingForContinuation &&
      requestErrorMessage === WAITING_FOR_CONTINUATION_REQUEST_ERROR_MESSAGE
    ) {
      clearRequestErrorMessage()
    }
  }, [clearRequestErrorMessage, requestErrorMessage, waitingForContinuation])

  const handleRemoveMedia = useCallback(
    (attachmentId: string) => {
      if (preview?.attachmentId === attachmentId) {
        closePreview()
      }

      removeAttachment(attachmentId, mediaNameSeeds)
    },
    [closePreview, mediaNameSeeds, preview?.attachmentId, removeAttachment],
  )

  const handleReorderMedia = useCallback(
    (activeId: string, overId: string) => {
      reorderAttachments(activeId, overId, mediaNameSeeds)
    },
    [mediaNameSeeds, reorderAttachments],
  )

  const rootClassName = embedded ? 'relative w-full' : 'relative w-full md:w-fit'
  const shellClassName = embedded
    ? 'project-composer-embedded layer-local-1 relative flex w-full min-w-0 flex-col justify-end overflow-hidden rounded-none border-0 border-transparent text-on-background shadow-none'
    : 'layer-local-1 relative flex w-full flex-col justify-end overflow-hidden text-on-background md:w-[68vw] md:max-w-[920px] md:min-w-[720px]'
  const contentClassName = embedded
    ? 'relative flex flex-col px-3 pb-2 pt-3 text-body leading-[1.55]'
    : 'relative flex flex-col px-5 pb-4 pt-4 text-body leading-[1.6]'
  const rowClassName = embedded
    ? 'flex flex-col gap-2 md:flex-row md:items-end md:gap-3'
    : 'flex flex-col gap-3 md:flex-row md:items-center md:gap-3'
  const editorClassName = embedded
    ? 'min-h-[2.5rem] max-h-[12rem] overflow-y-auto whitespace-pre-wrap text-body leading-[1.55] transition-[min-height,max-height] ui-motion-m'
    : 'min-h-[5rem] whitespace-pre-wrap text-body leading-[1.6] md:min-h-[6rem]'

  return (
    <div className={rootClassName}>
      <ComposerShell
        className={shellClassName}
        dropHint="拖拽图片、视频或音频到这里"
        isDropActive={dropZoneProps.isDragActive}
        onDragEnter={dropZoneProps.onDragEnter}
        onDragLeave={dropZoneProps.onDragLeave}
        onDragOver={dropZoneProps.onDragOver}
        onDrop={dropZoneProps.onDrop}
        onDropCapture={dropZoneProps.onDropCapture}
      >
        <div className={contentClassName}>
          <div className={rowClassName}>
            {isDesktop ? (
              <ComposerMediaStack
                compact={embedded}
                disabled={isInteractionLocked}
                attachments={attachments}
                onFilesSelected={ingestFiles}
                onOpenPreview={(attachment) =>
                  openPreview(composerAttachmentToPreviewItem(attachment))
                }
                onReorderMedia={handleReorderMedia}
                onRemoveMedia={handleRemoveMedia}
                referencedAttachmentIds={referencedAttachmentIds}
              />
            ) : null}

            <div className="relative min-w-0 flex-1">
              <MediaComposerEditor
                ariaLabel="项目编辑输入框"
                attachments={attachments}
                className={editorClassName}
                disabled={isInteractionLocked}
                document={document}
                focusRequestKey={focusRequestKey}
                libraryMedia={libraryMedia}
                onDocumentChange={setDocument}
                onFilesSelected={ingestFiles}
                onOpenMediaPreview={(reference) =>
                  openPreview(mediaComposerReferenceToPreviewItem(reference))
                }
                onSubmitRequest={handleSubmitDraft}
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
              className="mt-3 rounded-lg border border-chat-error-border bg-chat-error-bg px-3 py-2 text-label leading-5 text-chat-error-text"
              role="alert"
            >
              {attachmentErrorMessage}
            </div>
          ) : null}

          {visibleRequestErrorMessage ? (
            <div
              className="mt-3 rounded-lg border border-chat-error-border bg-chat-error-bg px-3 py-2 text-label leading-5 text-chat-error-text"
              role="alert"
            >
              {visibleRequestErrorMessage}
            </div>
          ) : null}

          <ProjectComposerToolbar
            compact={embedded}
            disabled={submitDisabled}
            onSubmit={handleSubmitDraft}
          />
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
