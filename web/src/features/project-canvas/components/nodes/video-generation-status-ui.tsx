import type { GeneratedVideoStatus } from '@/features/artifacts'
import { cn } from '@/shared/lib/utils'

export interface VideoGenerationStatusItem {
  promptIndex?: number
  status: GeneratedVideoStatus
}

interface VideoGenerationStatusMeta {
  accent: string
  dotClassName: string
  label: string
  progressWidth: string
  ringClassName: string
  status: GeneratedVideoStatus
}

const VIDEO_GENERATION_STATUS_META = {
  cancelled: {
    accent: 'muted',
    dotClassName: 'bg-[var(--color-outline)]',
    label: '已取消',
    progressWidth: '100%',
    ringClassName: 'border-[var(--color-outline)]/55',
    status: 'cancelled',
  },
  failed: {
    accent: 'red',
    dotClassName: 'bg-[var(--color-error)]',
    label: '生成失败',
    progressWidth: '100%',
    ringClassName: 'border-[var(--color-error)]/55',
    status: 'failed',
  },
  processing: {
    accent: 'amber',
    dotClassName: 'bg-[var(--color-tertiary)]',
    label: '生成中',
    progressWidth: '64%',
    ringClassName: 'border-[var(--color-tertiary)]/60',
    status: 'processing',
  },
  queued: {
    accent: 'grey',
    dotClassName: 'bg-[var(--color-on-surface-variant)]',
    label: '排队中',
    progressWidth: '28%',
    ringClassName: 'border-[var(--color-on-surface-variant)]/55',
    status: 'queued',
  },
  running: {
    accent: 'amber',
    dotClassName: 'bg-[var(--color-tertiary)]',
    label: '生成中',
    progressWidth: '72%',
    ringClassName: 'border-[var(--color-tertiary)]/60',
    status: 'running',
  },
  succeeded: {
    accent: 'green',
    dotClassName: 'bg-[var(--color-secondary)]',
    label: '生成成功',
    progressWidth: '100%',
    ringClassName: 'border-[var(--color-secondary)]/58',
    status: 'succeeded',
  },
} as const satisfies Record<GeneratedVideoStatus, VideoGenerationStatusMeta>

/**
 * 为生成视频创建可读标签。
 *
 * @param item - 单条视频生成状态。
 * @returns 用于预览弹窗和状态卡片的短标签。
 */
export const createVideoGenerationLabel = (item: Pick<VideoGenerationStatusItem, 'promptIndex'>) =>
  item.promptIndex ? `视频 ${String(item.promptIndex).padStart(2, '0')}` : '视频预览'

/**
 * 读取单条视频生成状态的展示元数据。
 *
 * @param status - 后端返回的视频生成状态。
 * @returns 当前状态对应的标题、色彩和进度元数据。
 */
export const getVideoGenerationStatusMeta = (status: GeneratedVideoStatus) =>
  VIDEO_GENERATION_STATUS_META[status]

/**
 * 渲染状态卡片里的动态点阵背景。
 *
 * @returns 与生成状态卡一致的轻量点阵背景层。
 */
export function VideoGenerationDottedBackground() {
  return <span aria-hidden="true" className="video-generation-dotted-background absolute inset-0" />
}

/**
 * 渲染状态卡片的中心符号。
 *
 * @param props - 状态符号属性。
 * @param props.meta - 状态卡片元数据。
 * @returns 对应阶段的圆环、进度或完成符号。
 */
function VideoGenerationStatusGlyph({ meta }: { meta: VideoGenerationStatusMeta }) {
  const isGenerating = meta.status === 'processing' || meta.status === 'running'

  return (
    <span
      aria-hidden="true"
      className={cn(
        'relative grid h-[72px] w-[72px] place-items-center rounded-full border bg-[color:color-mix(in_srgb,var(--color-surface-container-lowest)_62%,transparent)] shadow-[var(--shadow-2)] backdrop-blur-sm',
        meta.ringClassName,
      )}
    >
      {isGenerating ? (
        <span
          className={cn(
            'absolute inset-2 rounded-full border border-transparent border-t-[var(--color-tertiary)]/80',
            'animate-spin',
          )}
        />
      ) : null}
      <span className="grid h-11 w-11 place-items-center rounded-full border border-[var(--color-outline-variant)] bg-[color:color-mix(in_srgb,var(--color-surface-container-lowest)_80%,transparent)] opacity-100">
        {meta.status === 'succeeded' ? (
          <svg
            aria-hidden="true"
            className="h-5 w-5 text-[color:var(--color-secondary)]"
            fill="none"
            viewBox="0 0 24 24"
          >
            <title>生成成功</title>
            <path
              d="M5 12.4 9.2 16.5 19 7"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2.2"
            />
          </svg>
        ) : meta.status === 'failed' ? (
          <svg
            aria-hidden="true"
            className="h-5 w-5 text-[color:var(--color-error)]"
            fill="none"
            viewBox="0 0 24 24"
          >
            <title>生成失败</title>
            <path
              d="M7 7 17 17M17 7 7 17"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2.2"
            />
          </svg>
        ) : meta.status === 'cancelled' ? (
          <svg
            aria-hidden="true"
            className="h-5 w-5 text-[color:var(--color-outline)]"
            fill="none"
            viewBox="0 0 24 24"
          >
            <title>已取消</title>
            <path d="M7 12H17" stroke="currentColor" strokeLinecap="round" strokeWidth="2.2" />
          </svg>
        ) : (
          <span className={cn('h-2.5 w-2.5 rounded-full', meta.dotClassName)} />
        )}
      </span>
    </span>
  )
}

/**
 * 渲染单个视频生成状态卡片。
 *
 * @param props - 状态卡片属性。
 * @param props.className - 外部尺寸或交互态样式。
 * @param props.item - 后端返回的单条视频生成任务状态。
 * @returns 可复用的视频生成状态卡。
 */
export function VideoGenerationStatusTile({
  className,
  item,
}: {
  className?: string
  item: VideoGenerationStatusItem
}) {
  const meta = getVideoGenerationStatusMeta(item.status)

  return (
    <div
      className={cn(
        'relative isolate overflow-hidden rounded-xl border border-[var(--color-outline-variant)] bg-[var(--color-storyboard-canvas)] text-left transition-[transform,box-shadow,border-color] duration-[var(--dur-s)] ease-[var(--ease)]',
        className ?? 'aspect-[4/3]',
      )}
      data-video-generation-card="status"
      data-video-generation-shot={item.promptIndex ?? ''}
      data-video-generation-state={item.status}
    >
      <VideoGenerationDottedBackground />

      <span className="pointer-events-none absolute top-4 left-4 inline-flex items-center gap-2 rounded-full border border-[var(--color-outline-variant)] bg-[color:color-mix(in_srgb,var(--color-surface-container-lowest)_70%,transparent)] px-2.5 py-1 text-caption font-medium tracking-[0.16em] text-[color:var(--color-on-surface-variant)] uppercase backdrop-blur-md">
        <span className={cn('h-1.5 w-1.5 rounded-full', meta.dotClassName)} />
        {meta.accent}
      </span>

      <div className="pointer-events-none absolute inset-0 grid place-items-center pb-8">
        <VideoGenerationStatusGlyph meta={meta} />
      </div>

      <div className="absolute right-4 bottom-4 left-4 space-y-3">
        <div className="h-1 overflow-hidden rounded-full bg-black/[0.06]">
          <span
            className={[
              'block h-full rounded-full transition-[width] duration-500 ease-out',
              meta.dotClassName,
            ].join(' ')}
            style={{ width: meta.progressWidth }}
          />
        </div>
        <div className="flex items-end justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-title leading-tight font-medium text-[color:var(--color-on-surface)]">
              {meta.label}
            </p>
          </div>
          <span
            className={cn('mb-0.5 h-2 w-2 shrink-0 rounded-full', meta.dotClassName)}
            aria-hidden="true"
          />
        </div>
      </div>
    </div>
  )
}
