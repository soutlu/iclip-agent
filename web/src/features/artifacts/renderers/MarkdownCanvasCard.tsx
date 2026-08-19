import { useId, useMemo, useState } from 'react'
import MarkdownCanvasPreviewDialog from '@/features/artifacts/renderers/MarkdownCanvasPreviewDialog'
import ShotByShotScriptCanvasCard from '@/features/artifacts/renderers/ShotByShotScriptCanvasCard'
import { parseShotByShotScriptMarkdown } from '@/features/artifacts/renderers/shot-by-shot-script.utils'
import type {
  MarkdownArtifactOutput,
  MarkdownArtifactSourceMedia,
} from '@/features/artifacts/types/markdown.types'
import { RichMarkdownRenderer } from '@/shared/markdown'
import type { MediaPreviewItem } from '@/shared/ui/media'
import { MediaPreviewDialog, useMediaPreview } from '@/shared/ui/media'

interface MarkdownCanvasCardProps {
  markdown: MarkdownArtifactOutput
}

const MARKDOWN_IDENTITY_INVALID_CHARACTERS_PATTERN = /[^a-z0-9]+/g
const MARKDOWN_IDENTITY_EDGE_SEPARATOR_PATTERN = /^-+|-+$/g
const MARKDOWN_CARD_BASE_CLASS_NAME =
  'relative flex h-full min-h-0 w-full flex-col overflow-hidden bg-[var(--color-canvas-card-bg)] text-[color:var(--color-canvas-card-text)]'
const MARKDOWN_SOURCE_VIDEO_BANNER_CLASS_NAME =
  'nodrag nopan group relative isolate h-[240px] w-full shrink-0 overflow-hidden rounded-xl border border-[var(--color-outline-variant)] bg-[var(--color-artifact-rail-bg)] text-left'

/**
 * 将 React useId 输出转换为 DOM 与插件均可安全使用的 identity。
 *
 * @param value - React 生成的稳定组件 id。
 * @returns 去除冒号等特殊字符后的 identity 片段。
 */
const normalizeMarkdownIdentityPart = (value: string): string => {
  const normalizedValue = value
    .toLowerCase()
    .replaceAll(MARKDOWN_IDENTITY_INVALID_CHARACTERS_PATTERN, '-')
    .replaceAll(MARKDOWN_IDENTITY_EDGE_SEPARATOR_PATTERN, '')

  return normalizedValue || 'instance'
}

/**
 * 创建当前 Markdown 画布卡片的稳定 identity。
 *
 * @param reactId - React useId 返回的组件稳定 id。
 * @returns 带固定前缀的 Markdown renderer identity。
 */
const createMarkdownCanvasIdentity = (reactId: string): string => {
  return `markdown-canvas-card-${normalizeMarkdownIdentityPart(reactId)}`
}

/**
 * 解析 Markdown 节点标题的展示文案。
 *
 * @param title - 后端返回的原始标题。
 * @param sourceMediaKey - 当前来源媒体 key。
 * @returns 有视频头图时去掉标题末尾重复素材 key 后的标题。
 */
const resolveMarkdownDisplayTitle = (title: string, sourceMediaKey?: string) => {
  if (!sourceMediaKey) {
    return title
  }

  const escapedKey = sourceMediaKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const titleWithoutSourceKey = title
    .replace(new RegExp(`\\s*[：:]\\s*${escapedKey}\\s*$`), '')
    .trim()

  return titleWithoutSourceKey || title
}

/**
 * 阻止视频头图交互触发画布拖拽。
 *
 * @param event - 来源视频按钮的指针事件。
 */
const stopSourceVideoPointerPropagation = (event: { stopPropagation: () => void }) => {
  event.stopPropagation()
}

/**
 * 将 Markdown 来源视频转换为通用媒体预览项。
 *
 * @param displayName - 来源视频在预览弹层中的展示名。
 * @param sourceVideo - Markdown artifact 关联的视频媒体。
 * @returns 可交给媒体预览弹窗消费的视频预览数据。
 */
const markdownSourceVideoToPreviewItem = ({
  displayName,
  sourceVideo,
}: {
  displayName: string
  sourceVideo: MarkdownArtifactSourceMedia
}): MediaPreviewItem => ({
  attachmentId: sourceVideo.key,
  fileName: displayName,
  mediaType: 'video',
  thumbnailUrl: sourceVideo.thumbnailUrl,
  url: sourceVideo.url,
})

/**
 * 渲染展开预览图标。
 *
 * @returns 展开预览 SVG 图标。
 */
function ExpandMarkdownPreviewIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="27"
      viewBox="0 0 24 24"
      width="27"
      xmlns="http://www.w3.org/2000/svg"
    >
      <title>展开预览</title>
      <path
        d="M8 4H4v4"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2.2"
      />
      <path
        d="M4 4l6.5 6.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2.2"
      />
      <path
        d="M16 20h4v-4"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2.2"
      />
      <path
        d="M20 20l-6.5-6.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2.2"
      />
    </svg>
  )
}

/**
 * 渲染 Markdown 来源视频播放图标。
 *
 * @returns 来源视频横幅中心的播放 SVG 图标。
 */
function SourceVideoPlayIcon() {
  return (
    <svg aria-hidden="true" fill="currentColor" height="30" viewBox="0 0 256 256" width="30">
      <title>播放来源视频</title>
      <path d="M232,128a8,8,0,0,1-3.47,6.59l-144,88A8,8,0,0,1,72,216V40a8,8,0,0,1,12.53-6.59l144,88A8,8,0,0,1,232,128Z" />
    </svg>
  )
}

/**
 * 渲染 Markdown 节点头部的来源视频横幅。
 *
 * @param props - 来源视频横幅属性。
 * @param props.displayTitle - 当前 Markdown 节点的展示标题。
 * @param props.onPreview - 打开视频预览的回调。
 * @param props.sourceVideo - 当前 Markdown artifact 关联的来源视频。
 * @returns 裁切展示的视频缩略横幅。
 */
function MarkdownSourceVideoBanner({
  displayTitle,
  onPreview,
  sourceVideo,
}: {
  displayTitle: string
  onPreview: (preview: MediaPreviewItem) => void
  sourceVideo: MarkdownArtifactSourceMedia
}) {
  const previewItem = markdownSourceVideoToPreviewItem({
    displayName: displayTitle,
    sourceVideo,
  })
  const fileName = sourceVideo.filename ?? sourceVideo.key

  return (
    <button
      aria-label={`播放来源视频 ${fileName}`}
      className={MARKDOWN_SOURCE_VIDEO_BANNER_CLASS_NAME}
      onClick={(event) => {
        event.stopPropagation()
        onPreview(previewItem)
      }}
      onPointerDown={stopSourceVideoPointerPropagation}
      title={`播放来源视频 ${fileName}`}
      type="button"
    >
      <video
        autoPlay
        className="absolute inset-0 h-full w-full scale-[1.04] object-cover object-center transition-transform duration-200 ease-out group-hover:scale-[1.08]"
        loop
        muted
        playsInline
        poster={sourceVideo.thumbnailUrl}
        preload="metadata"
        src={sourceVideo.url}
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[image:var(--media-scrim-cover)]"
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[image:var(--media-vignette)]"
      />
      <span className="pointer-events-none absolute inset-0 grid place-items-center">
        <span className="grid h-20 w-20 place-items-center rounded-full border border-white/26 bg-white/24 text-white shadow-[var(--shadow-2)] backdrop-blur-md transition-transform duration-[var(--dur-s)] group-hover:scale-[1.04]">
          <SourceVideoPlayIcon />
        </span>
      </span>
      <span className="pointer-events-none absolute inset-x-4 bottom-4 flex items-center justify-between gap-3">
        <span className="max-w-[45%] truncate rounded-full border border-white/18 bg-black/36 px-3 py-1.5 text-label font-medium text-white shadow-[var(--shadow-2)] backdrop-blur-md">
          {sourceVideo.key}
        </span>
        <span className="rounded-full border border-white/18 bg-black/36 px-3 py-1.5 text-label font-medium text-white shadow-[var(--shadow-2)] backdrop-blur-md">
          来源视频
        </span>
      </span>
    </button>
  )
}

/**
 * 渲染通用 Markdown 画布卡片。
 *
 * @param props - Markdown 画布卡片属性。
 * @param props.markdown - 后端返回的 Markdown 标题与正文。
 * @returns 包含标题区、展开入口和 rich markdown 正文的画布卡片。
 */
export default function MarkdownCanvasCard({ markdown }: MarkdownCanvasCardProps) {
  const reactId = useId()
  const identity = useMemo(() => createMarkdownCanvasIdentity(reactId), [reactId])
  const sourceVideo = markdown.sourceMedia?.kind === 'video' ? markdown.sourceMedia : undefined
  const displayTitle = resolveMarkdownDisplayTitle(markdown.title, sourceVideo?.key)
  const shotByShotScript = useMemo(
    () => parseShotByShotScriptMarkdown(markdown.markdown),
    [markdown.markdown],
  )
  const [markdownPreviewOpen, setMarkdownPreviewOpen] = useState(false)
  const {
    closePreview: closeMediaPreview,
    openPreview: openMediaPreview,
    preview: mediaPreview,
  } = useMediaPreview()

  /**
   * 打开 Markdown 展开预览弹层。
   *
   * @returns 无返回值；副作用是切换展开预览状态。
   */
  const openPreview = () => {
    setMarkdownPreviewOpen(true)
  }

  /**
   * 关闭 Markdown 展开预览弹层。
   *
   * @returns 无返回值；副作用是切换展开预览状态。
   */
  const closePreview = () => {
    setMarkdownPreviewOpen(false)
  }

  if (shotByShotScript) {
    return (
      <ShotByShotScriptCanvasCard
        markdown={{ ...markdown, title: displayTitle }}
        script={shotByShotScript}
        variant="canvas"
      />
    )
  }

  return (
    <article className={MARKDOWN_CARD_BASE_CLASS_NAME}>
      <div className="canvas-card-accent-glow pointer-events-none absolute inset-x-0 top-0 h-28" />

      <div className="relative flex min-h-0 flex-1 flex-col gap-5 px-6 py-6">
        <header className="flex shrink-0 items-start justify-between gap-5">
          <div className="min-w-0">
            <p className="text-caption font-medium tracking-[0.16em] text-[color:var(--color-on-surface-variant)] uppercase">
              Markdown
            </p>
            <h2 className="mt-1 min-w-0 truncate text-canvas-title leading-tight font-medium text-[color:var(--color-canvas-card-text)]">
              {displayTitle}
            </h2>
          </div>
          <button
            aria-label="展开预览"
            className="markdown-canvas-icon-button markdown-canvas-expand-button nodrag nopan shrink-0"
            onClick={openPreview}
            style={{ height: 48, width: 48 }}
            title="展开预览"
            type="button"
          >
            <ExpandMarkdownPreviewIcon />
          </button>
        </header>

        <div
          className="markdown-canvas-body nodrag nopan nowheel thin-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain border-t border-[var(--color-outline-variant)] pt-5"
          data-scrollable
        >
          {sourceVideo ? (
            <div className="mb-5">
              <MarkdownSourceVideoBanner
                displayTitle={displayTitle}
                onPreview={openMediaPreview}
                sourceVideo={sourceVideo}
              />
            </div>
          ) : null}
          <RichMarkdownRenderer
            identity={identity}
            markdown={markdown.markdown}
            variant="canvas-preview"
          />
        </div>
      </div>
      {markdownPreviewOpen ? (
        <MarkdownCanvasPreviewDialog
          identity={identity}
          markdown={{ ...markdown, title: displayTitle }}
          onClose={closePreview}
        />
      ) : null}
      {mediaPreview ? (
        <MediaPreviewDialog
          key={`${mediaPreview.mediaType}:${mediaPreview.attachmentId ?? mediaPreview.url}`}
          onClose={closeMediaPreview}
          preview={mediaPreview}
        />
      ) : null}
    </article>
  )
}
