import { useEffect, useRef, useState, type DragEvent } from 'react'
import { MEDIA_IMAGE_ACCEPT, MEDIA_VIDEO_ACCEPT, uploadMediaFile } from '@/shared/api/media-upload'
import { Icon } from '@/shared/icons'
import { videoSnapshotUrl } from '@/shared/lib/media-url'
import { cn } from '@/shared/lib/utils'
import { IconButton } from '@/shared/ui/button'
import { MediaLightbox, type LightboxMedia } from '@/shared/ui/media-lightbox'

type TaskMediaFieldProps = {
  label: string
  kind: 'image' | 'video'
  value: readonly string[]
  onChange: (urls: string[]) => void
  disabled?: boolean
  maxFiles?: number
  compact?: boolean
  onUploadingChange?: (busy: boolean) => void
}

/** 只维护素材引用；移除不会删除上传文件，关闭表单后不会应用迟到的上传结果。 */
export function TaskMediaField({
  label,
  kind,
  value,
  onChange,
  disabled = false,
  maxFiles = kind === 'video' ? 1 : 16,
  compact = false,
  onUploadingChange,
}: TaskMediaFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const operationRef = useRef({ active: true, busy: false })
  const callbacksRef = useRef({ onChange, onUploadingChange })
  const dragDepthRef = useRef(0)
  const [uploading, setUploading] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [progress, setProgress] = useState('')
  const [error, setError] = useState('')
  const [preview, setPreview] = useState<LightboxMedia | null>(null)
  const limit = Math.min(maxFiles, kind === 'video' ? 1 : 16)
  const blocked = disabled || uploading

  useEffect(() => {
    callbacksRef.current = { onChange, onUploadingChange }
  }, [onChange, onUploadingChange])

  useEffect(() => {
    const operation = operationRef.current
    operation.active = true
    return () => {
      operation.active = false
      if (operation.busy) callbacksRef.current.onUploadingChange?.(false)
    }
  }, [])

  const uploadFiles = async (files: readonly File[]) => {
    const operation = operationRef.current
    if (disabled || operation.busy || files.length === 0) return
    const available = kind === 'video' ? limit : limit - value.length
    if (files.length > available) {
      setError(
        kind === 'video'
          ? '每次只能选择一个参考视频'
          : `最多添加 ${limit} 张图片，还可添加 ${available} 张`,
      )
      return
    }
    operation.busy = true
    setUploading(true)
    setError('')
    callbacksRef.current.onUploadingChange?.(true)
    let nextUrls = [...value]
    const failures: string[] = []
    try {
      for (const [index, file] of files.entries()) {
        if (!operation.active) return
        setProgress(`正在上传 ${index + 1}/${files.length}：${file.name}`)
        try {
          const url = await uploadMediaFile(file, kind)
          if (!operation.active) return
          nextUrls = kind === 'video' ? [url] : [...nextUrls, url]
          callbacksRef.current.onChange(nextUrls)
        } catch (cause) {
          failures.push(`${file.name}：${cause instanceof Error ? cause.message : '上传失败'}`)
        }
      }
      if (operation.active && failures.length > 0) {
        setError(`上传失败 ${failures.length} 个，已成功上传的素材已保留。${failures.join('；')}`)
      }
    } finally {
      operation.busy = false
      if (operation.active) {
        setUploading(false)
        setProgress('')
        callbacksRef.current.onUploadingChange?.(false)
      }
    }
  }

  const hasFiles = (event: DragEvent) => event.dataTransfer.types.includes('Files')
  const onDragEnter = (event: DragEvent<HTMLDivElement>) => {
    if (!hasFiles(event)) return
    event.preventDefault()
    dragDepthRef.current += 1
    if (!blocked) setDragOver(true)
  }
  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!hasFiles(event)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = blocked ? 'none' : 'copy'
  }
  const onDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (!hasFiles(event)) return
    event.preventDefault()
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) setDragOver(false)
  }
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!hasFiles(event)) return
    // 保留冒泡以清理全局拖放状态，defaultPrevented 表明此字段已接管上传。
    event.preventDefault()
    dragDepthRef.current = 0
    setDragOver(false)
    if (blocked) return
    if ([...event.dataTransfer.items].some((item) => item.webkitGetAsEntry?.()?.isDirectory)) {
      setError('请选择文件，不支持上传文件夹')
      return
    }
    void uploadFiles([...event.dataTransfer.files])
  }

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <span className="text-body-sm text-on-surface-variant">{label}</span>
      <div
        aria-busy={uploading}
        aria-label={label}
        className={cn(
          'relative flex flex-wrap gap-2 rounded-sm',
          dragOver && 'outline-2 outline-offset-4 outline-primary',
        )}
        onDragEnter={onDragEnter}
        onDragLeave={onDragLeave}
        onDragOver={onDragOver}
        onDrop={onDrop}
        role="group"
      >
        {value.map((url, index) => (
          <div
            className={cn(
              'relative overflow-hidden rounded-sm border border-border bg-surface-container-low',
              kind === 'video'
                ? 'flex w-full items-center gap-3 p-2'
                : compact
                  ? 'size-20'
                  : 'size-28',
            )}
            key={url}
          >
            <button
              aria-label={`预览${label} ${index + 1}`}
              className={cn(
                'cursor-zoom-in overflow-hidden rounded-xs ui-focus',
                kind === 'video'
                  ? 'grid size-12 shrink-0 place-items-center bg-surface-container'
                  : 'size-full',
              )}
              onClick={() => setPreview({ kind, name: `${label} ${index + 1}`, url })}
              type="button"
            >
              {kind === 'image' ? (
                <img
                  alt={`${label} ${index + 1}`}
                  className="size-full object-contain"
                  draggable={false}
                  src={url}
                />
              ) : (
                <VideoThumbnail url={url} />
              )}
            </button>
            {kind === 'video' && (
              <span className="min-w-0 flex-1 text-body-sm text-on-surface-variant">
                已添加参考视频 · 点击预览
              </span>
            )}
            {!disabled && (
              <IconButton
                className={cn(kind === 'image' && 'absolute top-0 right-0 bg-surface/90')}
                disabled={uploading}
                label={`移除${label} ${index + 1}`}
                name="close"
                onClick={() => onChange(value.filter((_, position) => position !== index))}
                size="sm"
              />
            )}
          </div>
        ))}
        {!disabled && (kind === 'video' || value.length < limit) && (
          <button
            aria-label={`${value.length > 0 && kind === 'video' ? '替换' : '添加'}${label}`}
            className={cn(
              'flex ui-state cursor-pointer items-center justify-center gap-2 rounded-sm border border-dashed border-outline-variant bg-surface text-on-surface-variant ui-focus disabled:cursor-not-allowed',
              kind === 'video'
                ? 'h-10 w-full text-body-sm'
                : compact
                  ? 'size-20 flex-col text-caption'
                  : 'size-28 flex-col text-body-sm',
            )}
            disabled={blocked}
            onClick={() => inputRef.current?.click()}
            type="button"
          >
            <Icon
              decorative
              name={kind === 'video' ? 'video' : 'add'}
              size={kind === 'video' ? 'sm' : 'lg'}
            />
            {kind === 'video' ? (value.length > 0 ? '替换参考视频' : '添加参考视频') : '添加图片'}
          </button>
        )}
        {disabled && value.length === 0 && (
          <p className="text-body-sm text-on-surface-faint">未添加</p>
        )}
        {dragOver && !blocked && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center rounded-sm bg-primary-container/90 text-body-sm text-on-primary-container">
            松开{kind === 'video' && value.length > 0 ? '替换视频' : '添加素材'}
          </div>
        )}
      </div>
      <input
        accept={kind === 'image' ? MEDIA_IMAGE_ACCEPT : MEDIA_VIDEO_ACCEPT}
        aria-label={`选择${label}文件`}
        className="hidden"
        disabled={blocked}
        multiple={kind === 'image' && limit > 1}
        onChange={(event) => {
          const files = [...(event.target.files ?? [])]
          event.target.value = ''
          void uploadFiles(files)
        }}
        ref={inputRef}
        type="file"
      />
      {uploading && (
        <p className="flex items-center gap-2 text-caption text-on-surface-variant" role="status">
          <Icon className="shrink-0 animate-spin" decorative name="loading" size="sm" />
          <span className="min-w-0 break-all">{progress}</span>
        </p>
      )}
      {error && (
        <p className="text-caption break-all text-error" role="alert">
          {error}
        </p>
      )}
      <MediaLightbox media={preview} onClose={() => setPreview(null)} />
    </div>
  )
}

function VideoThumbnail({ url }: { url: string }) {
  const [failed, setFailed] = useState(false)
  const thumbnail = videoSnapshotUrl(url)
  if (thumbnail === undefined || failed) return <Icon decorative name="video" size="lg" />
  return (
    <img
      alt=""
      className="size-full object-cover"
      onError={() => setFailed(true)}
      src={thumbnail}
    />
  )
}
