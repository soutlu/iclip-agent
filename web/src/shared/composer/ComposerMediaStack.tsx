import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  type DragStartEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import {
  horizontalListSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { ChangeEvent, CSSProperties } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ComposerFileAttachment } from '@/shared/composer/composer.types'
import { COMPOSER_MEDIA_FILE_ACCEPT } from '@/shared/composer/composer-attachment.utils'
import {
  COMPOSER_MEDIA_STACK_CARD_HEIGHT,
  COMPOSER_MEDIA_STACK_CARD_WIDTH,
  COMPOSER_MEDIA_STACK_GAP,
  COMPOSER_MEDIA_STACK_POINTER_ACTIVATION_DISTANCE,
  getComposerMediaStackRotation,
} from '@/shared/composer/composer-media-stack.utils'
import { cn } from '@/shared/lib/utils'

interface ComposerMediaStackProps {
  attachments: ComposerFileAttachment[]
  compact?: boolean
  disabled?: boolean
  onFilesSelected: (files: File[]) => void
  onOpenPreview: (attachment: ComposerFileAttachment) => void
  onRemoveMedia: (attachmentId: string) => void
  onReorderMedia: (activeId: string, overId: string) => void
  /**
   * 被正文引用的附件 id。提供时暂存区区分两态：未引用的卡片灰显并提示
   * 「本次发送不包含」（聊天只发送被 @ 引用的媒体）；不提供时维持
   * 「卡片即载荷」的全发送语义（视频生成入口）。
   */
  referencedAttachmentIds?: ReadonlySet<string>
}

const EMPTY_ADD_CARD_ROTATION = '-10deg'

const invertRotation = (value: string) => (value.startsWith('-') ? value.slice(1) : `-${value}`)

export default function ComposerMediaStack({
  attachments,
  compact = false,
  disabled = false,
  onFilesSelected,
  onOpenPreview,
  onRemoveMedia,
  onReorderMedia,
  referencedAttachmentIds,
}: ComposerMediaStackProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const previewSuppressedRef = useRef(false)
  const previewSuppressionTimerRef = useRef<number | undefined>(undefined)
  const [activeId, setActiveId] = useState<string | null>(null)
  const attachmentIds = useMemo(() => attachments.map((item) => item.id), [attachments])
  const itemCount = attachments.length + 1
  const cardHeight = compact ? 58 : COMPOSER_MEDIA_STACK_CARD_HEIGHT
  const cardWidth = compact ? 40 : COMPOSER_MEDIA_STACK_CARD_WIDTH
  const expandedWidth =
    itemCount * cardWidth + Math.max(0, itemCount - 1) * COMPOSER_MEDIA_STACK_GAP
  const collapsedWidth = cardWidth + 4
  const stackStyle = {
    '--composer-media-card-height': `${cardHeight}px`,
    '--composer-media-card-width': `${cardWidth}px`,
    '--composer-media-expanded-width': `${expandedWidth}px`,
    '--composer-media-step': `${cardWidth + COMPOSER_MEDIA_STACK_GAP}px`,
  } as CSSProperties
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: COMPOSER_MEDIA_STACK_POINTER_ACTIVATION_DISTANCE,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  )

  useEffect(
    () => () => {
      if (typeof window === 'undefined' || previewSuppressionTimerRef.current === undefined) {
        return
      }

      window.clearTimeout(previewSuppressionTimerRef.current)
    },
    [],
  )

  const clearPreviewSuppressionSoon = () => {
    if (typeof window === 'undefined') {
      previewSuppressedRef.current = false
      return
    }

    if (previewSuppressionTimerRef.current !== undefined) {
      window.clearTimeout(previewSuppressionTimerRef.current)
    }

    previewSuppressionTimerRef.current = window.setTimeout(() => {
      previewSuppressedRef.current = false
      previewSuppressionTimerRef.current = undefined
    }, 0)
  }

  const handleInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = Array.from(event.currentTarget.files ?? [])
    event.currentTarget.value = ''

    if (disabled || selectedFiles.length === 0) {
      return
    }

    onFilesSelected(selectedFiles)
  }

  const handleDragStart = ({ active }: DragStartEvent) => {
    if (disabled) {
      return
    }

    const nextActiveId = typeof active.id === 'string' ? active.id : null

    if (!nextActiveId) {
      return
    }

    previewSuppressedRef.current = true
    setActiveId(nextActiveId)
  }

  const handleDragCancel = () => {
    setActiveId(null)
    clearPreviewSuppressionSoon()
  }

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    setActiveId(null)
    clearPreviewSuppressionSoon()

    if (
      disabled ||
      typeof active.id !== 'string' ||
      typeof over?.id !== 'string' ||
      active.id === over.id
    ) {
      return
    }

    onReorderMedia(active.id, over.id)
  }

  const handleOpenPreview = (item: ComposerFileAttachment) => {
    if (previewSuppressedRef.current) {
      return
    }

    onOpenPreview(item)
  }

  return (
    <div className="flex w-[52px] shrink-0 items-center overflow-visible pl-1 md:pl-2">
      <input
        ref={fileInputRef}
        type="file"
        accept={COMPOSER_MEDIA_FILE_ACCEPT}
        disabled={disabled}
        multiple
        className="hidden"
        onChange={handleInputChange}
      />

      <DndContext
        collisionDetection={closestCenter}
        onDragCancel={handleDragCancel}
        onDragEnd={handleDragEnd}
        onDragStart={handleDragStart}
        sensors={sensors}
      >
        <div
          className={cn(
            'composer-media-stack overflow-visible',
            compact ? 'composer-media-stack--compact' : '',
          )}
          aria-disabled={disabled}
          data-dragging={activeId ? 'true' : 'false'}
          style={stackStyle}
        >
          <div
            className="composer-media-stack-shell"
            style={{ height: `${cardHeight}px`, width: `${collapsedWidth}px` }}
          >
            <div className="composer-media-stack-hover-trigger" aria-hidden="true" />

            <div
              className="composer-media-stack-track"
              style={{ height: `${cardHeight}px`, width: `${collapsedWidth}px` }}
            >
              <SortableContext items={attachmentIds} strategy={horizontalListSortingStrategy}>
                {attachments.map((item, index) => (
                  <SortableMediaCard
                    key={item.id}
                    index={index}
                    item={item}
                    disabled={disabled}
                    onOpenPreview={handleOpenPreview}
                    onRemoveMedia={onRemoveMedia}
                    referenced={
                      referencedAttachmentIds ? referencedAttachmentIds.has(item.id) : true
                    }
                  />
                ))}
              </SortableContext>

              <div
                className="composer-media-stack-item composer-media-stack-item--add"
                data-has-media={attachments.length > 0}
                style={
                  {
                    '--stack-counter-rotation':
                      attachments.length === 0 ? invertRotation(EMPTY_ADD_CARD_ROTATION) : '0deg',
                    '--stack-index': attachments.length.toString(),
                    '--stack-rotation': attachments.length === 0 ? EMPTY_ADD_CARD_ROTATION : '0deg',
                  } as CSSProperties
                }
              >
                <button
                  type="button"
                  className="composer-media-stack-card composer-media-stack-add"
                  aria-label="上传图片、视频或音频"
                  disabled={disabled}
                  title="上传图片、视频或音频"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <svg
                    aria-hidden="true"
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                  >
                    <title>上传图片、视频或音频</title>
                    <path d="M10.8 20a1.2 1.2 0 0 0 2.4 0v-6.8H20a1.2 1.2 0 1 0 0-2.4h-6.8V4a1.2 1.2 0 0 0-2.4 0v6.8H4a1.2 1.2 0 0 0 0 2.4h6.8V20Z" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        </div>
      </DndContext>
    </div>
  )
}

interface SortableMediaCardProps {
  disabled: boolean
  index: number
  item: ComposerFileAttachment
  onOpenPreview: (item: ComposerFileAttachment) => void
  onRemoveMedia: (attachmentId: string) => void
  referenced: boolean
}

function SortableMediaCard({
  disabled,
  index,
  item,
  onOpenPreview,
  onRemoveMedia,
  referenced,
}: SortableMediaCardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    disabled,
    id: item.id,
  })
  const rotation = getComposerMediaStackRotation(item.id)
  const sortableStyle = {
    transform: CSS.Transform.toString(transform),
    transition,
  } as CSSProperties
  const cardTitle = referenced
    ? disabled
      ? item.name
      : `拖拽排序 ${item.name}`
    : `${item.name}（未插入正文，本次发送不包含）`

  return (
    <div
      className="composer-media-stack-item"
      data-dragging={isDragging ? 'true' : 'false'}
      data-referenced={referenced ? 'true' : 'false'}
      style={
        {
          '--stack-counter-rotation': invertRotation(rotation),
          '--stack-index': index.toString(),
          '--stack-rotation': rotation,
        } as CSSProperties
      }
    >
      <div
        ref={setNodeRef}
        className="composer-media-stack-item-sortable"
        style={sortableStyle}
        {...attributes}
        {...listeners}
        title={cardTitle}
      >
        <div
          className={cn(
            'composer-media-stack-item-card-shell',
            referenced ? '' : 'opacity-50 saturate-50',
          )}
        >
          <MediaCard
            disabled={disabled}
            item={item}
            onOpenPreview={onOpenPreview}
            onRemoveMedia={onRemoveMedia}
          />
        </div>
      </div>
    </div>
  )
}

function MediaCard({
  disabled,
  item,
  onOpenPreview,
  onRemoveMedia,
}: {
  disabled: boolean
  item: ComposerFileAttachment
  onOpenPreview: (attachment: ComposerFileAttachment) => void
  onRemoveMedia: (attachmentId: string) => void
}) {
  return (
    <div className="composer-media-stack-card">
      <button
        aria-label={`预览附件：${item.name}`}
        className="absolute inset-0 block overflow-hidden rounded-[inherit] bg-transparent p-0 text-left"
        onClick={() => onOpenPreview(item)}
        title={`预览 ${item.name}`}
        type="button"
      >
        {item.kind === 'audio' ? (
          <span
            className="absolute inset-0 flex items-center justify-center rounded-[inherit] bg-thumb-fallback text-white"
            role="img"
            aria-label={item.name}
          >
            <svg
              aria-hidden="true"
              width="20"
              height="20"
              viewBox="0 0 256 256"
              fill="currentColor"
            >
              <title>音频</title>
              <path d="M210.3,56.8A8,8,0,0,0,203,56H96A16,16,0,0,0,80,72V168.4A31.8,31.8,0,0,0,64,164c-17.6,0-32,12.1-32,27s14.4,27,32,27,32-12.1,32-27V112H200v56.4A31.8,31.8,0,0,0,184,164c-17.6,0-32,12.1-32,27s14.4,27,32,27,32-12.1,32-27V64A8,8,0,0,0,210.3,56.8ZM96,96V72H200V96Z" />
            </svg>
          </span>
        ) : item.kind === 'image' ? (
          <span
            className="absolute inset-0 block rounded-[inherit] bg-cover bg-center bg-no-repeat"
            role="img"
            aria-label={item.name}
            style={{ backgroundImage: `url("${item.thumbnailUrl ?? item.url}")` }}
          />
        ) : (
          <video
            className="absolute inset-0 h-full w-full object-cover"
            aria-label={item.name}
            muted
            playsInline
            preload="metadata"
            src={item.url}
          />
        )}

        {item.kind !== 'image' ? (
          <span className="composer-media-stack-video-badge" aria-hidden="true">
            <svg width="8" height="8" viewBox="0 0 256 256" fill="currentColor">
              <title>{item.kind === 'audio' ? '音频' : '视频'}</title>
              {item.kind === 'audio' ? (
                <path d="M210.3,56.8A8,8,0,0,0,203,56H96A16,16,0,0,0,80,72V168.4A31.8,31.8,0,0,0,64,164c-17.6,0-32,12.1-32,27s14.4,27,32,27,32-12.1,32-27V112H200v56.4A31.8,31.8,0,0,0,184,164c-17.6,0-32,12.1-32,27s14.4,27,32,27,32-12.1,32-27V64A8,8,0,0,0,210.3,56.8ZM96,96V72H200V96Z" />
              ) : (
                <path d="M232,128a8,8,0,0,1-3.47,6.59l-144,88A8,8,0,0,1,72,216V40a8,8,0,0,1,12.53-6.59l144,88A8,8,0,0,1,232,128Z" />
              )}
            </svg>
          </span>
        ) : null}
      </button>

      <button
        type="button"
        className="composer-media-stack-remove"
        aria-label={`移除附件：${item.name}`}
        disabled={disabled}
        title={`移除附件：${item.name}`}
        onClick={(event) => {
          event.stopPropagation()
          onRemoveMedia(item.id)
        }}
        onPointerDown={(event) => {
          event.stopPropagation()
        }}
      >
        <svg aria-hidden="true" width="10" height="10" viewBox="0 0 256 256" fill="currentColor">
          <title>移除附件</title>
          <path d="M205.66,194.34a8,8,0,0,1-11.32,11.32L128,139.31,61.66,205.66A8,8,0,0,1,50.34,194.34L116.69,128,50.34,61.66A8,8,0,0,1,61.66,50.34L128,116.69l66.34-66.35a8,8,0,0,1,11.32,11.32L139.31,128Z" />
        </svg>
      </button>
    </div>
  )
}
