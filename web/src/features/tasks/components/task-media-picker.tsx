import { Plus, X } from 'lucide-react'
import { type ChangeEvent, useRef } from 'react'
import { type ComposerFileAttachment, useComposerFileDropZone } from '@/shared/composer'

type TaskMediaKind = Extract<ComposerFileAttachment['kind'], 'image' | 'video'>
type TaskMediaLayout = 'inline' | 'rail'

type TaskMediaRailProps = {
  attachments: ComposerFileAttachment[]
  category?: string
  errorMessage?: string
  helperId?: string
  inputName: string
  kind: TaskMediaKind
  label: string
  layout: TaskMediaLayout
  onFilesSelected: (files: File[]) => void
  onVideoMetadata?: (url: string, duration: number) => void
  onRemove: (attachmentId: string) => void
  pendingCount: number
}

const TASK_MEDIA_ACCEPT: Record<TaskMediaKind, string> = {
  image: 'image/*',
  video: 'video/*',
}

/**
 * 渲染一条可独立拖放、添加和删除的 Task 素材轨道。
 */
function TaskMediaRail({
  attachments,
  category,
  errorMessage,
  helperId,
  inputName,
  kind,
  label,
  layout,
  onFilesSelected,
  onVideoMetadata,
  onRemove,
  pendingCount,
}: TaskMediaRailProps) {
  const dropZone = useComposerFileDropZone({ onFilesSelected })
  const inputRef = useRef<HTMLInputElement>(null)

  const handleInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files ?? [])
    onFilesSelected(files)
    event.currentTarget.value = ''
  }

  return (
    <>
      <div
        aria-describedby={helperId}
        className="home-task-media-rail"
        data-category={category}
        data-drag-active={dropZone.isDragActive ? 'true' : 'false'}
        data-kind={kind}
        data-layout={layout}
        onDragEnter={dropZone.onDragEnter}
        onDragLeave={dropZone.onDragLeave}
        onDragOver={dropZone.onDragOver}
        onDrop={dropZone.onDrop}
        onDropCapture={dropZone.onDropCapture}
      >
        {attachments.map((attachment) => (
          <figure className="home-task-pending-media" key={attachment.id}>
            {kind === 'video' ? (
              <video
                aria-label={`${label} ${attachment.name}`}
                className="media-natural-ratio"
                muted
                playsInline
                poster={attachment.thumbnailUrl}
                preload="metadata"
                src={attachment.url}
                onLoadedMetadata={(event) =>
                  onVideoMetadata?.(attachment.url, event.currentTarget.duration)
                }
              />
            ) : (
              <img
                alt={`${label} ${attachment.name}`}
                className="media-natural-ratio"
                src={attachment.url}
              />
            )}

            <button
              aria-label={`移除${label} ${attachment.name}`}
              className="home-task-media-remove"
              type="button"
              onClick={() => onRemove(attachment.id)}
            >
              <X aria-hidden="true" size={10} strokeWidth={2} />
            </button>
          </figure>
        ))}

        <button
          aria-label={`添加${label}`}
          className="home-task-media-add"
          type="button"
          onClick={() => inputRef.current?.click()}
        >
          <Plus aria-hidden="true" size={20} strokeWidth={1.6} />
          {layout === 'inline' && dropZone.isDragActive ? (
            <span className="home-task-media-drop-hint">释放以上传</span>
          ) : null}
        </button>
        <input
          ref={inputRef}
          accept={TASK_MEDIA_ACCEPT[kind]}
          aria-label={`选择${label}`}
          className="home-task-media-input"
          multiple
          name={inputName}
          type="file"
          onChange={handleInputChange}
        />

        {layout === 'rail' && dropZone.isDragActive ? (
          <span className="home-task-media-drop-hint">释放以上传</span>
        ) : null}
      </div>

      {pendingCount > 0 ? (
        <p className="home-task-media-status" data-layout={layout} role="status">
          正在处理素材…
        </p>
      ) : null}
      {errorMessage ? (
        <p className="home-task-media-error" data-layout={layout} role="alert">
          {errorMessage}
        </p>
      ) : null}
    </>
  )
}

/**
 * Task 素材入口：默认使用横向轨道，也可内嵌进父级素材轨道复用同一套上传逻辑。
 */
export function TaskMediaPicker({
  attachments,
  errorMessage,
  hideHeading = false,
  kind,
  label,
  layout = 'rail',
  onFilesSelected,
  onVideoMetadata,
  onRemove,
  pendingCount,
}: Omit<TaskMediaRailProps, 'category' | 'helperId' | 'inputName' | 'layout'> & {
  hideHeading?: boolean
  layout?: TaskMediaLayout
}) {
  const helperId = hideHeading ? undefined : `home-task-${kind}-media-helper`
  const mediaRail = (
    <TaskMediaRail
      attachments={attachments}
      errorMessage={errorMessage}
      helperId={helperId}
      inputName={kind === 'video' ? 'referenceVideos' : 'referenceImages'}
      kind={kind}
      label={label}
      layout={layout}
      pendingCount={pendingCount}
      onFilesSelected={onFilesSelected}
      onVideoMetadata={onVideoMetadata}
      onRemove={onRemove}
    />
  )

  if (layout === 'inline') {
    return (
      <>
        <span className="sr-only" id={helperId}>
          可拖放上传，也可点击添加
        </span>
        {mediaRail}
      </>
    )
  }

  if (hideHeading) {
    return (
      <section aria-label={label} className="home-task-media-picker">
        {mediaRail}
      </section>
    )
  }

  return (
    <section aria-label={label} className="home-task-media-picker">
      <div className="home-task-media-heading">
        <h3>{label}</h3>
        <span id={helperId}>可拖放上传，也可点击添加</span>
      </div>
      {mediaRail}
    </section>
  )
}
