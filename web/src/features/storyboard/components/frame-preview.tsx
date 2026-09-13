/** 以帧号和地址为 key 挂载；切换图片即丢弃旧上传，点击与拖放共用替换流程。 */

import { useEffect, useEffectEvent, useRef, useState, type DragEvent } from 'react'
import { Icon } from '@/shared/icons'
import { IconButton } from '@/shared/ui/button'
import { toast } from '@/shared/ui/toast'
import { frameBadgeText, type FrameBadge } from '../frame-status'
import { aspectRatioStyle } from '../shots'
import { FRAME_IMAGE_ACCEPT } from '../storyboard.api'
import { FrameBadgeIcon } from './frame-badge'

type FramePreviewProps = {
  aspectRatio: string
  disabled: boolean
  caption?: string | undefined
  /** 这一帧最新图片任务的状态；没有任务或已经看过就不给。 */
  badge?: FrameBadge | undefined
  name: string
  url: string | undefined
  onOpen: () => void
  onEdit?: (() => void) | undefined
  onUpload: (file: File) => Promise<string>
  onReplace: (url: string) => void
  onUploadingChange: (uploading: boolean) => void
}

export function FramePreview({
  aspectRatio,
  badge,
  disabled,
  caption,
  name,
  onOpen,
  onEdit,
  onReplace,
  onUploadingChange,
  onUpload,
  url,
}: FramePreviewProps) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const uploadRef = useRef({ active: true, busy: false })
  const dragDepthRef = useRef(0)
  const [uploading, setUploading] = useState(false)
  const [dragOver, setDragOver] = useState(false)

  useEffect(() => {
    const upload = uploadRef.current
    upload.active = true
    return () => {
      upload.active = false
    }
  }, [])

  const replaceFromFiles = async (files: readonly File[]) => {
    const upload = uploadRef.current
    if (disabled || upload.busy) return
    if (url === undefined) {
      toast.error('当前镜头还没有可替换的图片')
      return
    }
    const file = files[0]
    if (files.length !== 1 || file === undefined) {
      toast.error('每次只能选择一张本地图片')
      return
    }
    upload.busy = true
    setUploading(true)
    try {
      const nextUrl = await onUpload(file)
      if (upload.active) onReplace(nextUrl)
    } catch (error) {
      if (upload.active) toast.error(error instanceof Error ? error.message : '上传失败')
    } finally {
      upload.busy = false
      if (upload.active) setUploading(false)
    }
  }

  const reportUploading = useEffectEvent(onUploadingChange)
  useEffect(() => {
    reportUploading(uploading)
    return () => reportUploading(false)
  }, [uploading])

  const hasFiles = (event: DragEvent) => event.dataTransfer.types.includes('Files')
  const onDragEnter = (event: DragEvent<HTMLDivElement>) => {
    if (!hasFiles(event)) return
    event.preventDefault()
    dragDepthRef.current += 1
    if (!disabled && !uploadRef.current.busy && url !== undefined) setDragOver(true)
  }
  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!hasFiles(event)) return
    event.preventDefault()
    event.dataTransfer.dropEffect =
      disabled || uploadRef.current.busy || url === undefined ? 'none' : 'copy'
  }
  const onDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (!hasFiles(event)) return
    event.preventDefault()
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) setDragOver(false)
  }
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!hasFiles(event)) return
    // 全局监听器仍需清理聊天拖放遮罩，通过 defaultPrevented 告知它此处已接管。
    event.preventDefault()
    dragDepthRef.current = 0
    setDragOver(false)
    if (disabled || uploadRef.current.busy) return
    if ([...event.dataTransfer.items].some((item) => item.webkitGetAsEntry?.()?.isDirectory)) {
      toast.error('请拖入一张图片文件，不支持文件夹')
      return
    }
    void replaceFromFiles([...event.dataTransfer.files])
  }

  return (
    <div
      aria-label="当前帧图片"
      className="storyboard-media relative min-h-0 min-w-0 bg-surface-container"
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
      role="group"
    >
      {url === undefined ? (
        <p className="text-body-sm text-on-surface-faint">这个镜头还没有帧</p>
      ) : (
        <>
          <button
            aria-label="打开原图"
            className="absolute inset-0 cursor-zoom-in ui-focus"
            onClick={onOpen}
            type="button"
          >
            <img
              alt={name}
              className="size-full object-contain"
              draggable={false}
              src={url}
              style={{ aspectRatio: aspectRatioStyle(aspectRatio) }}
            />
          </button>
          {caption === undefined ? null : (
            <p className="pointer-events-none absolute right-2 bottom-2 left-2 rounded-xs bg-surface-container-lowest px-2 py-1 text-caption text-on-surface-variant">
              {caption}
            </p>
          )}
          {badge === undefined ? null : badge.kind === 'result' && onEdit !== undefined ? (
            <button
              className="absolute top-2 left-2 flex cursor-pointer items-center gap-1.5 rounded-xs bg-surface-container-lowest px-2 py-1 text-caption text-on-surface ui-focus disabled:cursor-default"
              disabled={disabled || uploading}
              onClick={onEdit}
              type="button"
            >
              <FrameBadgeIcon badge={badge} size="sm" />
              有新结果 · 查看
            </button>
          ) : (
            <p
              className="pointer-events-none absolute top-2 left-2 flex items-center gap-1.5 rounded-xs bg-surface-container-lowest px-2 py-1 text-caption text-on-surface"
              role={badge.kind === 'failed' ? 'alert' : 'status'}
            >
              <FrameBadgeIcon badge={badge} size="sm" />
              {frameBadgeText(badge)}
              {badge.kind === 'failed' && badge.message !== null ? `：${badge.message}` : ''}
            </p>
          )}
          <div className="storyboard-frame-tools">
            {onEdit === undefined ? null : (
              <IconButton
                data-frame-edit=""
                disabled={disabled || uploading}
                label="编辑图片"
                title="编辑图片"
                name="edit-image"
                size="sm"
                onClick={onEdit}
              />
            )}
            <IconButton
              disabled={disabled || uploading}
              label="替换图片"
              name="image"
              onClick={() => inputRef.current?.click()}
              size="sm"
              title="替换图片"
            />
            <input
              accept={FRAME_IMAGE_ACCEPT}
              aria-label="选择替换图片"
              className="hidden"
              disabled={disabled || uploading}
              onChange={(event) => {
                const files = [...(event.target.files ?? [])]
                event.target.value = ''
                if (files.length > 0) void replaceFromFiles(files)
              }}
              ref={inputRef}
              type="file"
            />
          </div>
        </>
      )}
      {dragOver && !uploading ? (
        <div className="pointer-events-none absolute inset-0 grid place-items-center border-2 border-primary bg-primary-container-soft">
          <span className="rounded-xs bg-surface-container-lowest px-3 py-2 text-body-sm text-on-surface">
            松开替换当前图片
          </span>
        </div>
      ) : null}
      {uploading ? (
        <div
          className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 bg-scrim/32 text-body-sm text-on-scrim"
          role="status"
        >
          <Icon className="animate-spin" decorative name="loading" size="md" />
          正在上传…
        </div>
      ) : null}
    </div>
  )
}
