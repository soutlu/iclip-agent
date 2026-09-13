import { useEffect, useRef, useState, type DragEvent } from 'react'
import { MEDIA_IMAGE_ACCEPT, MEDIA_VIDEO_ACCEPT, uploadMediaFile } from '@/shared/api/media-upload'
import { Icon } from '@/shared/icons'
import { videoSnapshotUrl } from '@/shared/lib/media-url'
import { cn } from '@/shared/lib/utils'
import { MediaLightbox, type LightboxMedia } from '@/shared/ui/media-lightbox'

type TaskMediaFieldProps = {
  label: string
  /** 可访问名称的词根，同一表单里有多组同类素材时用它区分；默认就是 label。 */
  name?: string
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
  name = label,
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
      <div className="flex min-h-5 items-center gap-3">
        <span className="text-body-sm text-on-surface-variant">{label}</span>
        {kind === 'video' && value.length > 0 && !disabled && (
          <button
            aria-label={`替换${name}`}
            className="inline-flex ui-state cursor-pointer items-center gap-1 rounded-xs text-caption text-on-surface-variant ui-focus ui-focus-inline disabled:cursor-not-allowed"
            disabled={blocked}
            onClick={() => inputRef.current?.click()}
            type="button"
          >
            <Icon decorative name="video" size="xs" />
            替换视频
          </button>
        )}
      </div>
      <div
        aria-busy={uploading}
        aria-label={name}
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
              'relative',
              kind === 'video'
                ? 'w-full'
                : cn(
                    'overflow-hidden rounded-sm border border-border bg-surface-container-low',
                    compact ? 'size-20' : 'size-28',
                  ),
            )}
            key={url}
          >
            {kind === 'video' ? (
              <TaskVideoPreview
                name={`${name} ${index + 1}`}
                onOpen={() => setPreview({ kind, name: `${name} ${index + 1}`, url })}
                url={url}
              />
            ) : (
              <button
                aria-label={`预览${name} ${index + 1}`}
                className="size-full cursor-zoom-in overflow-hidden rounded-xs ui-focus"
                onClick={() => setPreview({ kind, name: `${name} ${index + 1}`, url })}
                type="button"
              >
                <img
                  alt={`${name} ${index + 1}`}
                  className="size-full object-contain"
                  draggable={false}
                  src={url}
                />
              </button>
            )}
            {!disabled && (
              <button
                aria-label={`移除${name} ${index + 1}`}
                className="absolute top-0 right-0 grid size-8 cursor-pointer place-items-center rounded-full ui-focus ui-focus-inline disabled:cursor-not-allowed"
                disabled={uploading}
                onClick={() => onChange(value.filter((_, position) => position !== index))}
                type="button"
              >
                <span className="grid size-5 place-items-center rounded-full border border-border bg-surface/95 text-on-surface">
                  <Icon decorative name="close" size="xs" />
                </span>
              </button>
            )}
          </div>
        ))}
        {!disabled && value.length < limit && (
          <button
            aria-label={`添加${name}`}
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
            {kind === 'video' ? '添加参考视频' : '添加图片'}
          </button>
        )}
        {disabled && value.length === 0 && (
          <p className="text-body-sm text-on-surface-faint">未添加</p>
        )}
        {dragOver && !blocked && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center rounded-sm bg-primary-container text-body-sm text-on-primary-container">
            松开{kind === 'video' && value.length > 0 ? '替换视频' : '添加素材'}
          </div>
        )}
      </div>
      <input
        accept={kind === 'image' ? MEDIA_IMAGE_ACCEPT : MEDIA_VIDEO_ACCEPT}
        aria-label={`选择${name}文件`}
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

/** 表单和发送预览共用；只显示素材首帧，由调用方打开完整播放器。 */
export function TaskVideoPreview({
  url,
  name,
  onOpen,
}: {
  url: string
  name: string
  onOpen: () => void
}) {
  const [duration, setDuration] = useState<number | null>(null)
  const [failed, setFailed] = useState(false)
  const durationLabel =
    duration === null
      ? null
      : `${Math.floor(duration / 60)
          .toString()
          .padStart(2, '0')}:${Math.floor(duration % 60)
          .toString()
          .padStart(2, '0')}`
  return (
    <button
      aria-label={`预览${name}`}
      className="relative block h-46 w-full cursor-zoom-in overflow-hidden rounded-sm border border-border bg-surface-container-highest ui-focus ui-focus-inline"
      onClick={onOpen}
      type="button"
    >
      <video
        aria-hidden="true"
        className="pointer-events-none size-full object-contain"
        muted
        onError={() => setFailed(true)}
        onLoadedMetadata={(event) => {
          const seconds = event.currentTarget.duration
          if (Number.isFinite(seconds)) setDuration(seconds)
        }}
        playsInline
        poster={videoSnapshotUrl(url)}
        preload="metadata"
        src={url}
        tabIndex={-1}
      />
      <span className="pointer-events-none absolute inset-0 grid place-items-center">
        <span className="grid size-11 place-items-center rounded-full bg-scrim/50 text-on-scrim">
          <Icon decorative name="play" size="xl" />
        </span>
      </span>
      {failed ? (
        <span className="absolute right-2 bottom-2 left-2 rounded-xs bg-scrim/60 px-2 py-1 text-caption text-on-scrim">
          视频暂时无法加载，点击打开预览
        </span>
      ) : durationLabel ? (
        <span className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-xs bg-scrim/60 px-2 py-0.5 text-caption text-on-scrim">
          {durationLabel}
        </span>
      ) : null}
    </button>
  )
}
