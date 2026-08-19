import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  type ComposerFileAttachment,
  revokeComposerAttachmentObjectUrls,
  revokeRemovedComposerAttachmentObjectUrls,
  useComposerFileIngress,
} from '@/shared/composer'

type TaskMediaKind = Extract<ComposerFileAttachment['kind'], 'image' | 'video'>

const TASK_MEDIA_ALLOWED_KINDS: Record<TaskMediaKind, readonly TaskMediaKind[]> = {
  image: ['image'],
  video: ['video'],
}

export function useTaskMediaAttachments(kind: TaskMediaKind) {
  const [attachments, setAttachments] = useState<ComposerFileAttachment[]>([])
  const [errorMessage, setErrorMessage] = useState<string>()
  const [pendingCount, setPendingCount] = useState(0)
  const activeRef = useRef(true)
  const latestAttachmentsRef = useRef(attachments)

  useLayoutEffect(() => {
    latestAttachmentsRef.current = attachments
  }, [attachments])

  useEffect(() => {
    activeRef.current = true

    return () => {
      activeRef.current = false
      revokeComposerAttachmentObjectUrls(latestAttachmentsRef.current)
    }
  }, [])

  const addFiles = useCallback((files: ComposerFileAttachment[]) => {
    setAttachments((current) => [...current, ...files])
  }, [])

  const remove = useCallback((attachmentId: string) => {
    setAttachments((current) => {
      const remaining = current.filter((attachment) => attachment.id !== attachmentId)
      if (remaining.length === current.length) {
        return current
      }

      revokeRemovedComposerAttachmentObjectUrls(current, remaining)
      return remaining
    })
    setErrorMessage(undefined)
  }, [])

  const ingest = useComposerFileIngress({
    addFiles,
    adjustPendingUploadCount: (delta) => setPendingCount((current) => current + delta),
    allowedKinds: TASK_MEDIA_ALLOWED_KINDS[kind],
    clearAttachmentErrorMessage: () => setErrorMessage(undefined),
    files: attachments,
    isActive: () => activeRef.current,
    setAttachmentErrorMessage: setErrorMessage,
  })

  return {
    attachments,
    errorMessage,
    ingest,
    pendingCount,
    remove,
  }
}

export const taskMediaAttachmentsToFiles = (attachments: ComposerFileAttachment[]) =>
  attachments.map((attachment) => {
    if (attachment.delivery !== 'local' || !(attachment.file instanceof File)) {
      throw new Error(`Task 素材 ${attachment.id} 缺少本地文件`)
    }

    return attachment.file
  })
