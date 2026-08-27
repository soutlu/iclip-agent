import {
  IMAGE_ANALYSIS_SUMMARY_NODE_TITLE,
  type ImageAnalysisSummaryItem,
  type ImageAnalysisSummaryOutput,
} from '@/features/artifacts/types/image-analysis-summary.types'
import { cn } from '@/shared/lib/utils'
import {
  MediaPreviewDialog,
  type MediaPreviewItem,
  MediaThumbnailSurface,
  useMediaPreview,
} from '@/shared/ui/media'

interface ImageAnalysisSummaryCanvasCardProps {
  summary: ImageAnalysisSummaryOutput
  variant?: 'canvas' | 'focused'
}

const CATEGORY_TONE_CLASSNAMES = {
  default: 'bg-surface-container-low text-on-surface-variant ring-outline-variant',
  person:
    'bg-error-container text-on-error-container ring-[color-mix(in_srgb,var(--color-error)_35%,transparent)]',
  product:
    'bg-primary-container text-on-primary-container ring-[color-mix(in_srgb,var(--color-primary)_35%,transparent)]',
  scene:
    'bg-secondary-container text-on-secondary-container ring-[color-mix(in_srgb,var(--color-secondary)_35%,transparent)]',
  storyboard:
    'bg-warning-container text-on-warning-container ring-[color-mix(in_srgb,var(--color-warning)_35%,transparent)]',
} as const
const FOCUSED_IMAGE_ANALYSIS_GRID_COLUMN_COUNT = 3
const FOCUSED_IMAGE_ANALYSIS_GRID_GAP = 12
const FOCUSED_IMAGE_ANALYSIS_MIN_COLUMN_WIDTH = 340
const FOCUSED_IMAGE_ANALYSIS_GRID_MIN_WIDTH =
  FOCUSED_IMAGE_ANALYSIS_GRID_COLUMN_COUNT * FOCUSED_IMAGE_ANALYSIS_MIN_COLUMN_WIDTH +
  (FOCUSED_IMAGE_ANALYSIS_GRID_COLUMN_COUNT - 1) * FOCUSED_IMAGE_ANALYSIS_GRID_GAP
const FOCUSED_IMAGE_ANALYSIS_GRID_TEMPLATE_COLUMNS = `repeat(auto-fit, minmax(${FOCUSED_IMAGE_ANALYSIS_MIN_COLUMN_WIDTH.toString()}px, 1fr))`
const FOCUSED_IMAGE_ANALYSIS_GRID_MIN_WIDTH_VALUE = `${FOCUSED_IMAGE_ANALYSIS_GRID_MIN_WIDTH.toString()}px`

/**
 * 统计图片解析汇总中的去重分类数量。
 *
 * @param items - 图片解析汇总条目列表。
 * @returns 去重后的分类数量。
 */
const countImageAnalysisCategories = (items: ImageAnalysisSummaryItem[]) =>
  new Set(items.map((item) => item.category.trim()).filter(Boolean)).size

/**
 * 解析输入图片节点的图片数量文案。
 *
 * @param itemCount - 汇总中的图片数量。
 * @returns 可展示在标题区胶囊中的数量文案。
 */
const resolveImageAnalysisTotalLabel = (itemCount: number) => `${itemCount.toString()} 张图片`

/**
 * 解析输入图片节点的分类数量文案。
 *
 * @param categoryCount - 汇总中的去重分类数量。
 * @returns 可展示在标题区深色胶囊中的分类文案。
 */
const resolveImageAnalysisCategoryLabel = (categoryCount: number) =>
  `${categoryCount.toString()} 类标签`

/**
 * 解析输入图片条目的前端展示标题。
 *
 * @param item - 当前图片解析摘要条目。
 * @returns 基于分类生成的固定展示标题。
 */
const resolveImageAnalysisItemTitle = (item: ImageAnalysisSummaryItem) => `${item.category}解析`

/**
 * 解析图片分类对应的色彩语义。
 *
 * @param category - 后端图片解析返回的分类文本。
 * @returns 适用于分类徽标的 Tailwind 类名。
 */
const resolveCategoryToneClassName = (category: string) => {
  if (category.includes('产品')) {
    return CATEGORY_TONE_CLASSNAMES.product
  }

  if (category.includes('场景')) {
    return CATEGORY_TONE_CLASSNAMES.scene
  }

  if (category.includes('分镜')) {
    return CATEGORY_TONE_CLASSNAMES.storyboard
  }

  if (category.includes('人物')) {
    return CATEGORY_TONE_CLASSNAMES.person
  }

  return CATEGORY_TONE_CLASSNAMES.default
}

/**
 * 将图片解析条目转换为预览弹窗数据。
 *
 * @param item - 图片解析汇总中的单个素材条目。
 * @returns 可交给媒体预览弹窗使用的图片预览项；缺少 URL 时返回 null。
 */
const imageAnalysisItemToPreview = (item: ImageAnalysisSummaryItem): MediaPreviewItem | null => {
  if (!item.url) {
    return null
  }

  return {
    attachmentId: item.key,
    fileName: item.filename ?? item.key,
    mediaType: 'image',
    thumbnailUrl: item.thumbnailUrl,
    url: item.url,
  }
}

/**
 * 渲染单个输入图片的解析摘要卡片。
 *
 * @param props - 图片解析卡片属性。
 * @param props.item - 当前图片解析摘要条目。
 * @param props.onPreview - 打开原图预览的回调。
 * @returns 图片缩略图、素材 key、分类和简短解析说明。
 */
function ImageAnalysisSummaryCard({
  item,
  onPreview,
  variant = 'canvas',
}: {
  item: ImageAnalysisSummaryItem
  onPreview: (preview: MediaPreviewItem) => void
  variant?: 'canvas' | 'focused'
}) {
  const preview = imageAnalysisItemToPreview(item)
  const categoryToneClassName = resolveCategoryToneClassName(item.category)
  const mediaLabel = item.filename ?? item.key
  const itemTitle = resolveImageAnalysisItemTitle(item)
  const isFocused = variant === 'focused'
  const articleClassName = cn(
    'group relative overflow-hidden border border-outline-variant text-left',
    isFocused
      ? 'block min-h-0 w-full self-start rounded-xl bg-artifact-rail-bg'
      : 'flex min-h-[330px] flex-col rounded-xl bg-canvas-card-bg',
  )
  const buttonClassName = cn(
    'nodrag nopan w-full transition-[transform,border-color] ui-motion-s',
    'hover:border-outline active:scale-[0.985]',
    articleClassName,
  )
  const mediaClassName = isFocused
    ? 'relative overflow-hidden bg-artifact-rail-bg'
    : 'relative aspect-[4/3] overflow-hidden bg-surface-container'
  const content = (
    <>
      <div className={mediaClassName} data-image-analysis-summary-card-media="true">
        {isFocused && item.url ? (
          <img
            alt=""
            className="block h-auto w-full object-contain transition-transform ui-motion-m group-hover:scale-[1.015]"
            data-image-analysis-summary-card-image="true"
            decoding="async"
            loading="lazy"
            src={item.url}
          />
        ) : item.url ? (
          <MediaThumbnailSurface
            className="absolute inset-0 h-full w-full transition-transform ui-motion-m group-hover:scale-[1.035]"
            fileName={mediaLabel}
            mediaType="image"
            thumbnailUrl={item.thumbnailUrl}
            url={item.url}
          />
        ) : (
          <div
            className={
              isFocused
                ? 'grid aspect-[4/3] w-full place-items-center bg-artifact-rail-bg text-body-sm font-medium text-white/62'
                : 'grid h-full w-full place-items-center bg-[linear-gradient(135deg,#f8fafd_0%,#eef2f6_52%,#fff7ed_100%)] text-body-sm font-medium text-on-surface-variant'
            }
          >
            {item.key}
          </div>
        )}

        <span
          aria-hidden="true"
          className={
            isFocused
              ? 'pointer-events-none absolute inset-x-0 bottom-0 h-[72%] bg-[image:var(--media-scrim-photo-strong)]'
              : 'pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-[image:var(--media-scrim-photo)]'
          }
        />

        {isFocused ? null : (
          <span className="absolute right-3 bottom-2.5 left-3 flex min-w-0 items-center justify-between gap-2">
            <span className="min-w-0 truncate text-label font-medium text-white">{mediaLabel}</span>
            <span className="inline-flex h-6 shrink-0 items-center gap-1 rounded-full bg-white/[0.14] px-2 text-caption font-medium text-white backdrop-blur-md">
              <svg
                aria-hidden="true"
                width="10"
                height="10"
                viewBox="0 0 256 256"
                fill="currentColor"
              >
                <title>图片</title>
                <path d="M216,40H40A16,16,0,0,0,24,56V200a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V56A16,16,0,0,0,216,40ZM40,56H216V151.31l-30.34-30.34a16,16,0,0,0-22.63,0L136,148,93.66,105.66a16,16,0,0,0-22.63,0L40,136.69ZM40,200V159.31l42.34-42.34L165.37,200Zm176,0H188L147.31,159.31l27.03-27.03L216,173.94V200ZM144,100a12,12,0,1,1,12,12A12,12,0,0,1,144,100Z" />
              </svg>
              <span>图片</span>
            </span>
          </span>
        )}
      </div>

      <div
        className={
          isFocused
            ? 'layer-local-1 pointer-events-none absolute inset-x-0 bottom-0 flex min-h-0 flex-col px-4 pt-14 pb-4 text-white'
            : 'flex flex-1 flex-col px-4 pt-3 pb-4'
        }
      >
        {isFocused ? (
          <span className="mb-1 min-w-0 text-body-sm font-medium text-white/72">{mediaLabel}</span>
        ) : null}
        <div
          className={
            isFocused
              ? 'flex items-start justify-between gap-2.5'
              : 'flex items-start justify-between gap-3'
          }
        >
          <h3
            className={
              isFocused
                ? 'min-w-0 text-title font-semibold text-white'
                : 'line-clamp-1 min-w-0 text-title font-medium text-canvas-card-text'
            }
            data-image-analysis-summary-card-title="true"
          >
            {itemTitle}
          </h3>
          <span
            className={cn(
              'shrink-0 rounded-full leading-none font-medium ring-1',
              isFocused ? 'px-2.5 py-1 text-label' : 'px-2.5 py-1 text-caption',
              isFocused
                ? 'bg-white/[0.16] text-white ring-white/[0.20] backdrop-blur-md'
                : categoryToneClassName,
            )}
          >
            {item.category}
          </span>
        </div>
        <p
          className={
            isFocused
              ? 'mt-2 text-title font-medium text-white/90'
              : 'mt-2 line-clamp-4 text-canvas-body leading-8 font-medium text-on-surface-variant'
          }
          data-image-analysis-summary-card-description="true"
        >
          {item.description}
        </p>
      </div>
    </>
  )

  if (!preview) {
    return <article className={articleClassName}>{content}</article>
  }

  return (
    <button
      aria-label={`打开 ${mediaLabel} 图片预览`}
      className={buttonClassName}
      data-image-analysis-summary-card="true"
      onClick={() => onPreview(preview)}
      type="button"
    >
      {content}
    </button>
  )
}

/**
 * 渲染集中承接输入图片解析结果的画布卡片。
 *
 * @param props - 图片解析汇总卡片属性。
 * @param props.summary - 已聚合的图片解析结果，画布内按 2 列滚动展示，focused 预览按图片数量控制列数。
 * @returns 输入图片汇总组件。
 */
export default function ImageAnalysisSummaryCanvasCard({
  summary,
  variant = 'canvas',
}: ImageAnalysisSummaryCanvasCardProps) {
  const { closePreview, openPreview, preview } = useMediaPreview()
  const totalLabel = resolveImageAnalysisTotalLabel(summary.items.length)
  const categoryLabel = resolveImageAnalysisCategoryLabel(
    countImageAnalysisCategories(summary.items),
  )
  const isFocused = variant === 'focused'
  const gridClassName = isFocused
    ? 'grid items-start gap-3'
    : 'grid grid-cols-2 gap-4 border-t border-outline-variant pt-5'
  const gridStyle = isFocused
    ? {
        gridTemplateColumns: FOCUSED_IMAGE_ANALYSIS_GRID_TEMPLATE_COLUMNS,
        minWidth: FOCUSED_IMAGE_ANALYSIS_GRID_MIN_WIDTH_VALUE,
        width: '100%',
      }
    : undefined

  return (
    <article
      className={
        isFocused
          ? 'relative flex flex-col overflow-visible text-on-background'
          : 'relative flex h-full min-h-0 flex-col overflow-hidden bg-canvas-card-bg text-canvas-card-text'
      }
    >
      {isFocused ? null : (
        <div className="canvas-card-accent-glow pointer-events-none absolute inset-x-0 top-0 h-28" />
      )}

      <div
        className={
          isFocused
            ? 'thin-scrollbar relative flex min-h-0 flex-col gap-3 overflow-hidden rounded-l-xl rounded-r-none bg-background px-4 py-4 shadow-[var(--shadow-3)]'
            : 'nowheel thin-scrollbar relative flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto overscroll-contain px-6 py-6'
        }
        data-image-analysis-summary-surface="true"
      >
        {isFocused ? null : (
          <header
            className="flex items-start justify-between gap-5"
            data-image-analysis-summary-header="true"
          >
            <div className="min-w-0">
              <p className="text-caption font-medium tracking-[0] text-on-surface-variant uppercase">
                Input Images
              </p>
              <h2 className="mt-1 text-canvas-title leading-tight font-medium text-canvas-card-text">
                {IMAGE_ANALYSIS_SUMMARY_NODE_TITLE}
              </h2>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              <span className="rounded-full border border-outline-variant bg-[color-mix(in_srgb,var(--color-canvas-card-bg)_72%,transparent)] px-3 py-1.5 text-label font-medium text-canvas-card-text shadow-[var(--shadow-2)]">
                {totalLabel}
              </span>
              <span className="rounded-full bg-artifact-rail-bg px-3 py-1.5 text-label font-medium text-white">
                {categoryLabel}
              </span>
            </div>
          </header>
        )}

        <div className={gridClassName} data-image-analysis-summary-grid="true" style={gridStyle}>
          {summary.items.map((item) => (
            <ImageAnalysisSummaryCard
              key={item.key}
              item={item}
              onPreview={openPreview}
              variant={variant}
            />
          ))}
        </div>
      </div>

      {preview ? (
        <MediaPreviewDialog
          key={`${preview.mediaType}:${preview.attachmentId ?? preview.url}`}
          onClose={closePreview}
          preview={preview}
        />
      ) : null}
    </article>
  )
}
