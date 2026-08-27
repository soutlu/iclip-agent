import { StoryboardShotRow } from '@/features/artifacts/renderers/storyboard/StoryboardTableCells'
import type { StoryboardFrameImageEntry } from '@/features/artifacts/renderers/storyboard/storyboard-frame-image.types'
import {
  storyboardFrameImageToPreviewItem,
  storyboardVideoToPreviewItem,
} from '@/features/artifacts/renderers/storyboard/storyboard-media-preview.utils'
import {
  getStoryboardSummaryItems,
  getStoryboardTableConfig,
  getSummaryItemStyle,
  STORYBOARD_PALETTE,
  TABLE_HEAD_CELL_CLASS,
} from '@/features/artifacts/renderers/storyboard/storyboard-table-config'
import type { StoryboardOutput, StoryboardShot } from '@/features/artifacts/types/storyboard.types'
import { MediaPreviewDialog, useMediaPreview } from '@/shared/ui/media'

interface StoryboardCanvasCardProps {
  storyboard: StoryboardOutput
}

/**
 * 为分镜行创建稳定 React key。
 *
 * @param shot - 单条分镜记录。
 * @returns 由镜头 id、结构层级和故事线组成的稳定 key。
 */
const getShotStableKey = (shot: StoryboardShot) =>
  [shot.id ?? 'shot', shot.structureLevel ?? 'structure', shot.storyline ?? 'storyline'].join(':')

/**
 * 渲染动态分镜表画布卡片。
 *
 * @param props - 分镜表卡片属性。
 * @param props.storyboard - 后端归一化后的分镜表输出。
 * @returns 固定外框内可横向和纵向滚动的分镜表卡片。
 */
export default function StoryboardCanvasCard({ storyboard }: StoryboardCanvasCardProps) {
  const palette = STORYBOARD_PALETTE
  const shots = storyboard.shotTable ?? []
  const { boardMinWidth, columns } = getStoryboardTableConfig(shots)
  const summaryItems = getStoryboardSummaryItems(storyboard)
  const { closePreview, openPreview, preview } = useMediaPreview()

  const handleImagePreviewOpen = (image: StoryboardFrameImageEntry, shot: StoryboardShot) => {
    openPreview(storyboardFrameImageToPreviewItem(image, shot))
  }

  const handleVideoPreviewOpen = (shot: StoryboardShot) => {
    const nextPreview = storyboardVideoToPreviewItem(shot)

    if (!nextPreview) {
      return
    }

    openPreview(nextPreview)
  }

  return (
    <article
      className="relative flex h-full min-h-0 flex-col overflow-hidden bg-canvas-card-bg text-canvas-card-text"
      data-storyboard-canvas-card="true"
    >
      <div className="canvas-card-accent-glow pointer-events-none absolute inset-x-0 top-0 h-28" />

      <div className="nodrag nopan nowheel thin-scrollbar relative flex min-h-0 w-full flex-1 flex-col gap-5 overflow-y-auto overscroll-contain px-6 py-6">
        <header className="flex items-start justify-between gap-5">
          <div className="min-w-0">
            <p className="text-label font-medium tracking-[0] text-on-surface-variant uppercase">
              Storyboard
            </p>
            <h2 className="mt-1 text-canvas-title leading-tight font-medium text-canvas-card-text">
              动态分镜表
            </h2>
          </div>

          <span className="shrink-0 rounded-full border border-outline-variant bg-[color:color-mix(in_srgb,var(--color-surface-container-lowest)_72%,transparent)] px-3 py-1.5 text-body font-medium text-canvas-card-text">
            {shots.length.toString()} 镜头
          </span>
        </header>

        {summaryItems.length > 0 ? (
          <div className="grid gap-3 border-t border-outline-variant pt-5 md:grid-cols-2 xl:grid-cols-4">
            {summaryItems.map((item) => {
              const itemStyle = getSummaryItemStyle(item, palette)

              return (
                <div
                  className="canvas-fragment-enter rounded-xl border px-4 py-3"
                  key={item.key}
                  style={{
                    backgroundColor: itemStyle.backgroundColor,
                    borderColor: itemStyle.borderColor,
                  }}
                >
                  <p
                    className="mb-2 text-body-sm font-semibold tracking-[0] uppercase"
                    style={{ color: itemStyle.color }}
                  >
                    {item.label}
                  </p>
                  <p className="text-canvas-label leading-7" style={{ color: palette.textPrimary }}>
                    {item.value}
                  </p>
                </div>
              )
            })}
          </div>
        ) : null}

        <section className="overflow-hidden rounded-xl border border-outline-variant bg-canvas-card-bg">
          <div className="nodrag nopan nowheel cursor-auto overflow-x-auto" data-scrollable>
            <table
              className="w-full table-fixed border-separate border-spacing-0"
              style={{ minWidth: boardMinWidth }}
            >
              <colgroup>
                {columns.map((column) => (
                  <col key={column.key} style={{ width: `${column.width}px` }} />
                ))}
              </colgroup>
              <thead>
                <tr style={{ backgroundColor: palette.accent }}>
                  {columns.map((column) => (
                    <th
                      className={TABLE_HEAD_CELL_CLASS}
                      data-storyboard-table-head-cell="true"
                      key={column.key}
                      style={{ color: 'var(--color-surface-container-low)' }}
                    >
                      {column.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shots.length > 0 ? (
                  shots.map((shot) => (
                    <StoryboardShotRow
                      columns={columns}
                      key={getShotStableKey(shot)}
                      onImagePreviewOpen={handleImagePreviewOpen}
                      onVideoPreviewOpen={handleVideoPreviewOpen}
                      palette={palette}
                      shot={shot}
                    />
                  ))
                ) : (
                  <tr>
                    <td
                      className="px-6 py-12 text-center text-canvas-title-sm"
                      colSpan={columns.length}
                      style={{ color: palette.textSecondary }}
                    >
                      暂未生成分镜段落，后续将根据返回的 `shot_list` 自动填充。
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
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
