import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  normalizeComposerAttachmentNamesByOrder,
  type ComposerFileAttachment,
  revokeComposerAttachmentObjectUrls,
  revokeRemovedComposerAttachmentObjectUrls,
  useComposerFileIngress,
} from '@/shared/composer'

const STORYBOARD_REFERENCE_IMAGE_KINDS = ['image'] as const

/**
 * 管理当前镜头修改指令的参考图片、对象 URL 与异步接入生命周期。
 *
 * `scopeId` 只用于拒绝上一镜头仍在处理的异步结果；镜头切换由调用方显式 `clear()`。
 *
 * @param scopeId - 当前项目与镜头组成的接入作用域。
 * @returns 图片目录、接入状态以及添加、删除、清空 intent。
 */
export const useStoryboardReferenceImages = (scopeId: string) => {
  const [images, setImages] = useState<ComposerFileAttachment[]>([])
  const [errorMessage, setErrorMessage] = useState<string>()
  const [pendingCount, setPendingCount] = useState(0)
  const activeScopeRef = useRef(scopeId)
  const latestImagesRef = useRef(images)

  useLayoutEffect(() => {
    activeScopeRef.current = scopeId
    latestImagesRef.current = images
  }, [images, scopeId])

  useEffect(
    () => () => {
      activeScopeRef.current = ''
      revokeComposerAttachmentObjectUrls(latestImagesRef.current)
    },
    [],
  )

  /**
   * 把已经完成校验与接入的图片追加到当前镜头目录。
   *
   * @param nextImages - 新接入的图片附件。
   * @returns 无返回值。
   */
  const addImages = useCallback((nextImages: ComposerFileAttachment[]) => {
    setImages((current) => [...current, ...nextImages])
  }, [])

  /**
   * 清空当前镜头图片并释放其对象 URL。
   *
   * @returns 无返回值。
   */
  const clear = useCallback(() => {
    setImages((current) => {
      revokeComposerAttachmentObjectUrls(current)
      return []
    })
    setErrorMessage(undefined)
  }, [])

  /**
   * 删除单张图片、释放已移除对象 URL，并重新派生提交别名。
   *
   * @param attachmentId - 待删除附件的稳定 ID。
   * @returns 无返回值。
   */
  const remove = useCallback((attachmentId: string) => {
    setImages((current) => {
      const remainingImages = current.filter((image) => image.id !== attachmentId)
      if (remainingImages.length === current.length) return current

      revokeRemovedComposerAttachmentObjectUrls(current, remainingImages)
      return normalizeComposerAttachmentNamesByOrder(remainingImages)
    })
    setErrorMessage(undefined)
  }, [])

  /**
   * 判断当前异步文件结果是否仍属于创建它的镜头。
   *
   * @returns 作用域仍匹配时返回 true。
   */
  const isActive = useCallback(() => activeScopeRef.current === scopeId, [scopeId])
  const ingest = useComposerFileIngress({
    addFiles: addImages,
    adjustPendingUploadCount: (delta) => setPendingCount((current) => current + delta),
    allowedKinds: STORYBOARD_REFERENCE_IMAGE_KINDS,
    clearAttachmentErrorMessage: () => setErrorMessage(undefined),
    files: images,
    isActive,
    setAttachmentErrorMessage: setErrorMessage,
  })

  return {
    clear,
    errorMessage,
    images,
    ingest,
    pendingCount,
    remove,
  }
}
