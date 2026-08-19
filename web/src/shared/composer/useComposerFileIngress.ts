import { useCallback } from 'react'
import type { ComposerFileAttachment } from '@/shared/composer/composer.types'
import {
  COMPOSER_MEDIA_LIMIT_ERROR_MESSAGE,
  createComposerAttachmentsFromFiles,
  deriveNextComposerMediaNameSequences,
  formatComposerAttachmentErrors,
  partitionComposerAttachmentsByLimits,
  revokeComposerAttachmentObjectUrls,
} from '@/shared/composer/composer-attachment.utils'

interface UseComposerFileIngressOptions {
  addFiles: (files: ComposerFileAttachment[]) => void
  adjustPendingUploadCount: (delta: number) => void
  allowedKinds?: ReadonlyArray<ComposerFileAttachment['kind']>
  clearAttachmentErrorMessage: () => void
  files: ComposerFileAttachment[]
  isActive?: () => boolean
  mediaNameSeeds?: Array<Pick<ComposerFileAttachment, 'kind' | 'name'>>
  setAttachmentErrorMessage: (message: string | undefined) => void
}

/**
 * 把文件接入边界之外的异常转换为可见错误，不把 Promise rejection 留给事件层。
 *
 * @param error - 文件处理或状态提交时抛出的未知异常。
 * @returns 可直接显示在 Composer 附件区域的错误文案。
 */
const formatUnexpectedFileIngressError = (error: unknown) => {
  if (error instanceof Error && error.message.trim().length > 0) {
    return `附件接入失败：${error.message}`
  }

  return '附件接入失败。'
}

/**
 * 管理 Composer 文件接入的异步处理、限制校验、对象 URL 和错误状态。
 *
 * @param options - 当前附件、入口限制、状态 intent 与可选作用域检查。
 * @returns 供 React 事件和 Tiptap FileHandler 调用的同步文件接入 intent。
 */
export const useComposerFileIngress = ({
  addFiles,
  adjustPendingUploadCount,
  allowedKinds,
  clearAttachmentErrorMessage,
  files,
  isActive,
  mediaNameSeeds = [],
  setAttachmentErrorMessage,
}: UseComposerFileIngressOptions) => {
  /**
   * 执行一次文件接入事务，并保证 pending 计数成对恢复。
   *
   * @param selectedFiles - 本次由选择、粘贴或拖放得到的文件。
   * @returns 文件接入完成时解决的 Promise。
   */
  const ingestFiles = useCallback(
    async (selectedFiles: File[]) => {
      if (selectedFiles.length === 0) {
        return
      }

      clearAttachmentErrorMessage()
      adjustPendingUploadCount(selectedFiles.length)

      try {
        const { nextAudioSequence, nextImageSequence, nextVideoSequence } =
          deriveNextComposerMediaNameSequences([...mediaNameSeeds, ...files])
        let audioSequence = nextAudioSequence
        let imageSequence = nextImageSequence
        let videoSequence = nextVideoSequence
        const { attachments, errors } = await createComposerAttachmentsFromFiles(selectedFiles, {
          getAttachmentName: (_file, mediaType) => {
            if (mediaType.startsWith('audio/')) {
              const attachmentName = `audio_${audioSequence}`
              audioSequence += 1
              return attachmentName
            }

            if (mediaType.startsWith('image/')) {
              const attachmentName = `image_${imageSequence}`
              imageSequence += 1
              return attachmentName
            }

            const attachmentName = `video_${videoSequence}`
            videoSequence += 1
            return attachmentName
          },
        })
        if (isActive && !isActive()) {
          revokeComposerAttachmentObjectUrls(attachments)
          return
        }

        const allowedKindSet = allowedKinds ? new Set(allowedKinds) : null
        const supportedAttachments = allowedKindSet
          ? attachments.filter((attachment) => allowedKindSet.has(attachment.kind))
          : attachments
        const unsupportedAttachments = allowedKindSet
          ? attachments.filter((attachment) => !allowedKindSet.has(attachment.kind))
          : []
        revokeComposerAttachmentObjectUrls(unsupportedAttachments)

        const { acceptedAttachments, rejectedAttachments } = partitionComposerAttachmentsByLimits(
          files,
          supportedAttachments,
        )

        if (rejectedAttachments.length > 0) {
          revokeComposerAttachmentObjectUrls(rejectedAttachments)
        }

        if (acceptedAttachments.length > 0) {
          try {
            addFiles(acceptedAttachments)
          } catch (error) {
            revokeComposerAttachmentObjectUrls(acceptedAttachments)
            throw error
          }
        }

        const formattedErrorMessage = formatComposerAttachmentErrors(errors)

        const limitErrorMessage =
          rejectedAttachments.length > 0 ? COMPOSER_MEDIA_LIMIT_ERROR_MESSAGE : undefined
        const unsupportedKindErrorMessage =
          unsupportedAttachments.length > 0 ? '当前入口不支持所选的附件类型。' : undefined
        const nextErrorMessage = [
          formattedErrorMessage,
          unsupportedKindErrorMessage,
          limitErrorMessage,
        ]
          .filter(Boolean)
          .join(' ')

        if (nextErrorMessage) {
          setAttachmentErrorMessage(nextErrorMessage)
          return
        }

        clearAttachmentErrorMessage()
      } finally {
        adjustPendingUploadCount(-selectedFiles.length)
      }
    },
    [
      addFiles,
      adjustPendingUploadCount,
      allowedKinds,
      clearAttachmentErrorMessage,
      files,
      isActive,
      mediaNameSeeds,
      setAttachmentErrorMessage,
    ],
  )

  /**
   * 从同步事件边界启动文件接入，并把意外异常写入当前入口错误状态。
   *
   * @param selectedFiles - 本次需要接入的文件。
   * @returns 无返回值；异步完成和错误由 Hook 内部管理。
   */
  const handleFilesSelected = useCallback(
    (selectedFiles: File[]) => {
      ingestFiles(selectedFiles).catch((error: unknown) => {
        if (isActive && !isActive()) return
        setAttachmentErrorMessage(formatUnexpectedFileIngressError(error))
      })
    },
    [ingestFiles, isActive, setAttachmentErrorMessage],
  )

  return handleFilesSelected
}
