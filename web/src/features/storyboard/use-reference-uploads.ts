import { useEffect, useRef, useState, type DragEvent } from 'react'
import { uploadMediaFile } from '@/shared/api/media-upload'
import { hasDraggedFiles } from '@/shared/lib/drag-files'
import { toast } from '@/shared/ui/toast'

type Options<T extends { id: string }> = {
  references: readonly T[]
  disabled: boolean
  /** 一次编辑最多带几张；超了整批不传，报 `tooMany`。 */
  limit: number
  tooMany: string
  onChange: (references: T[]) => void
  onBusyChange: (busy: boolean) => void
  /** 一张传好的图变成一条参考；回 `undefined` 表示已有同样的，不加。 */
  fromUpload: (file: File, url: string, current: readonly T[]) => T | undefined
}

/** 参考图托盘共用的一半：上传、上限、拖入、锁定。摆法与每条参考长什么样由各托盘自己定。
 *
 * 上传期间仍可移除已有参考图：按最新列表追加，不把移掉的装回来，所以列表在 ref 里镜像一份。 */
export const useReferenceUploads = <T extends { id: string }>({
  references,
  disabled,
  limit,
  tooMany,
  onChange,
  onBusyChange,
  fromUpload,
}: Options<T>) => {
  const latestRef = useRef(references)
  useEffect(() => {
    latestRef.current = references
  }, [references])
  const uploadingRef = useRef(false)
  const [uploading, setUploading] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const locked = disabled || uploading

  const upload = async (files: readonly File[]) => {
    if (locked || uploadingRef.current || files.length === 0) return
    if (files.length + latestRef.current.length > limit) {
      toast.error(tooMany)
      return
    }
    uploadingRef.current = true
    setUploading(true)
    onBusyChange(true)
    try {
      for (const file of files) {
        // 类型与尺寸由上传通道统一校验，这里不再复制一份规则。
        const url = await uploadMediaFile(file, 'image')
        const reference = fromUpload(file, url, latestRef.current)
        if (reference === undefined) continue
        const next = [...latestRef.current, reference]
        latestRef.current = next
        onChange(next)
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '参考图上传失败')
    } finally {
      uploadingRef.current = false
      setUploading(false)
      onBusyChange(false)
    }
  }

  const remove = (id: string) => onChange(latestRef.current.filter((item) => item.id !== id))

  // 拖进来先接管：保留冒泡让全局拖放状态收尾，defaultPrevented 表明此处已接管；锁定时标成禁止落点。
  const claimDrag = (event: DragEvent<HTMLElement>) => {
    if (!hasDraggedFiles(event)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = locked ? 'none' : 'copy'
    if (!locked) setDragOver(true)
  }
  const dragHandlers = {
    onDragEnter: claimDrag,
    onDragOver: claimDrag,
    onDragLeave: (event: DragEvent<HTMLElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragOver(false)
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      if (!hasDraggedFiles(event)) return
      event.preventDefault()
      setDragOver(false)
      if ([...event.dataTransfer.items].some((item) => item.webkitGetAsEntry?.()?.isDirectory)) {
        toast.error('请拖入图片文件，不支持文件夹')
        return
      }
      void upload([...event.dataTransfer.files])
    },
  }

  return { uploading, locked, dragOver, upload, remove, dragHandlers, latest: latestRef }
}
