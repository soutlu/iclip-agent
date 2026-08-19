import { useMemo, useState, type KeyboardEvent } from 'react'
import { MediaPreviewDialog, useMediaPreview, type MediaPreviewItem } from '@/shared/ui/media'
import { imageUrlsFromToolResult } from './debug-tool-result-image-urls'

export interface DebugImagePreview extends MediaPreviewItem {
  badge?: string
}

interface DebugImagePreviewRailProps {
  activation?: 'click' | 'double-click'
  ariaLabel: string
  images: readonly DebugImagePreview[]
}

interface DebugToolResultImagesProps {
  result: unknown
  toolName: string
}

const handlePreviewKeyDown = (event: KeyboardEvent<HTMLButtonElement>, openPreview: () => void) => {
  if (event.key !== 'Enter' && event.key !== ' ') return
  event.preventDefault()
  openPreview()
}

function DebugImagePreviewButton({
  activation,
  image,
  openPreview,
}: {
  activation: NonNullable<DebugImagePreviewRailProps['activation']>
  image: DebugImagePreview
  openPreview: (image: MediaPreviewItem) => void
}) {
  const [loadFailed, setLoadFailed] = useState(false)
  const actionLabel =
    activation === 'double-click' ? `双击查看${image.fileName}` : `查看${image.fileName}`
  const showPreview = () => openPreview(image)

  return (
    <button
      aria-label={actionLabel}
      className="storyboard-debug-frame-trigger"
      onClick={activation === 'click' ? showPreview : undefined}
      onDoubleClick={activation === 'double-click' ? showPreview : undefined}
      onKeyDown={(event) => handlePreviewKeyDown(event, showPreview)}
      title={activation === 'double-click' ? '双击查看大图' : '点击查看大图'}
      type="button"
    >
      <img
        alt={image.altText ?? image.fileName}
        className="media-natural-ratio pointer-events-none select-none"
        decoding="async"
        draggable={false}
        loading="lazy"
        onError={() => setLoadFailed(true)}
        referrerPolicy="no-referrer"
        src={image.url}
      />
      {loadFailed ? (
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-[var(--color-error-container)] px-3 text-center text-body-sm text-[var(--color-on-error-container)]">
          图片加载失败
        </span>
      ) : null}
      {image.badge ? (
        <span className="pointer-events-none absolute top-2 left-2 rounded-xs bg-[color:color-mix(in_srgb,var(--color-inverse-surface)_78%,transparent)] px-1.5 py-0.5 text-caption font-semibold text-[var(--color-inverse-on-surface)]">
          {image.badge}
        </span>
      ) : null}
    </button>
  )
}

/** 渲染调试工具图片的一行自然比例预览，并统一接入共享大图弹层。 */
export function DebugImagePreviewRail({
  activation = 'click',
  ariaLabel,
  images,
}: DebugImagePreviewRailProps) {
  const { closePreview, openPreview, preview } = useMediaPreview()

  if (images.length === 0) return null

  return (
    <>
      <ol aria-label={ariaLabel} className="storyboard-debug-frame-rail" data-scrollable>
        {images.map((image) => (
          <li className="shrink-0" key={image.attachmentId ?? `${image.fileName}:${image.url}`}>
            <DebugImagePreviewButton
              activation={activation}
              image={image}
              openPreview={openPreview}
            />
          </li>
        ))}
      </ol>
      {preview ? <MediaPreviewDialog onClose={closePreview} preview={preview} /> : null}
    </>
  )
}

/** 在普通工具的原始结果下方追加图片 URL 的可视化预览。 */
export default function DebugToolResultImages({ result, toolName }: DebugToolResultImagesProps) {
  const images = useMemo(
    () =>
      imageUrlsFromToolResult(result).map<DebugImagePreview>((url, index) => {
        const orderLabel = String(index + 1).padStart(2, '0')
        const label = `${toolName} 结果图片 ${orderLabel}`
        return {
          altText: label,
          attachmentId: `${toolName}:result-image:${index}:${url}`,
          badge: orderLabel,
          fileName: label,
          mediaType: 'image',
          url,
        }
      }),
    [result, toolName],
  )

  if (images.length === 0) return null

  return (
    <section aria-label={`${toolName} 结果图片`} className="mt-3">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <p className="text-body-sm font-semibold text-[var(--color-on-surface)]">结果图片</p>
        <p className="text-label text-[var(--color-on-surface-variant)]">
          共 {images.length} 张 · 点击查看大图
        </p>
      </div>
      <DebugImagePreviewRail ariaLabel={`${toolName} 结果图片`} images={images} />
    </section>
  )
}
