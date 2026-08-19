import type { ComponentProps, CSSProperties, ReactNode } from 'react'
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  CreativeBriefCanvasCard,
  ImageAnalysisSummaryCanvasCard,
  type MarkdownArtifactSourceMedia,
  parseShotByShotScriptMarkdown,
  ShotByShotScriptCanvasCard,
  StoryboardCanvasCard,
  VideoPromptCanvasCard,
} from '@/features/artifacts'
import { useProjectChatVideoGeneration } from '@/features/chat'
import type { CanvasViewportExtraNode } from '@/features/project-canvas/components/CanvasViewport'
import type {
  MarkdownProjectCanvasNode,
  ProjectCanvasArtifactKind,
  ProjectCanvasFlowNode,
  VideoPromptProjectCanvasNode,
} from '@/features/project-canvas/components/nodes/project-canvas-node.types'
import {
  STORYBOARD_WORKBENCH_NODE_HEIGHT,
  STORYBOARD_WORKBENCH_NODE_WIDTH,
} from '@/features/project-canvas/components/nodes/storyboard-workbench/storyboard-workbench.constants'
import type { StoryboardWorkbenchProjectCanvasNode } from '@/features/project-canvas/components/nodes/storyboard-workbench/storyboard-workbench.types'
import StoryboardWorkbenchCanvasNode from '@/features/project-canvas/components/nodes/storyboard-workbench/StoryboardWorkbenchCanvasNode'
import { UiCardCanvasBody } from '@/features/project-canvas/components/nodes/UiCardCanvasNode'
import { useProjectCanvasStore } from '@/features/project-canvas/state/project-canvas-store'
import { cn } from '@/shared/lib/utils'
import { RichMarkdownRenderer } from '@/shared/markdown'
import HippoIcon, { type HippoIconName } from '@/shared/ui/icons/HippoIcon'
import { MediaPreviewDialog, type MediaPreviewItem, useMediaPreview } from '@/shared/ui/media'

const FOCUSED_ARTIFACT_KIND_LABELS: Record<ProjectCanvasArtifactKind, string> = {
  brief: '简报',
  'image-analysis-summary': '图片解析',
  markdown: '文档',
  storyboard: '分镜',
  'ui-card': '卡片',
  'video-prompt': '提示词',
}

const MARKDOWN_IDENTITY_INVALID_CHARACTERS_PATTERN = /[^a-z0-9]+/g
const MARKDOWN_IDENTITY_EDGE_SEPARATOR_PATTERN = /^-+|-+$/g
const FOCUSED_ARTIFACT_ZOOM_BASE_LEVEL = 60
const FOCUSED_ARTIFACT_ZOOM_MAX_SCALE = 3
const FOCUSED_ARTIFACT_ZOOM_MIN_SCALE = 0.35

const BOOKMARK_ICON_SIZE = 32
const BOOKMARK_DISPLAY_TITLE_MAX_CHARACTERS = 5
const BOOKMARK_DISPLAY_TITLE_TRAILING_SEPARATOR_PATTERN = /[\s:：·_-]+$/
const FOCUSED_STORYBOARD_INITIAL_SCALE = 0.28
const FOCUSED_STORYBOARD_MAX_SCALE = 1
const FOCUSED_STORYBOARD_MIN_SCALE = 0.22

const BOOKMARK_KIND_COLORS: Record<ProjectCanvasArtifactKind, string> = {
  brief: 'var(--color-artifact-brief)',
  'image-analysis-summary': 'var(--color-artifact-image-analysis)',
  markdown: 'var(--color-artifact-markdown)',
  storyboard: 'var(--color-artifact-storyboard)',
  'ui-card': 'var(--color-artifact-ui-card)',
  'video-prompt': 'var(--color-artifact-video-prompt)',
}

const BOOKMARK_ICON_BY_KIND: Record<ProjectCanvasArtifactKind, HippoIconName> = {
  brief: 'survey',
  'image-analysis-summary': 'image-text',
  markdown: 'file-common',
  storyboard: 'movie',
  'ui-card': 'layout',
  'video-prompt': 'video-prompt',
}

const FOCUSED_MARKDOWN_SOURCE_VIDEO_CLASS =
  'nodrag nopan group relative isolate block h-[198px] w-full overflow-hidden border-b border-[var(--color-border)] bg-black text-left'
const FOCUSED_STORYBOARD_SURFACE_STYLE = {
  backgroundColor: 'var(--storyboard-node-surface)',
} as const satisfies CSSProperties

interface ProjectCanvasFocusedArtifactProps {
  extraArtifactNodes?: CanvasViewportExtraNode[]
  leftOffset: string
}

interface FocusedArtifactSurfaceProps {
  children: ReactNode
}

interface FocusedArtifactMarkdownViewProps {
  node: MarkdownProjectCanvasNode
}

interface FocusedArtifactVideoPromptViewProps {
  node: VideoPromptProjectCanvasNode
}

interface ProjectCanvasFocusedArtifactStyle extends CSSProperties {
  '--layout-project-focused-artifact-left': string
  '--layout-project-focused-artifact-scale': string
}

interface FocusedArtifactStoryboardWorkbenchStyle extends CSSProperties {
  '--layout-project-focused-storyboard-height': string
  '--layout-project-focused-storyboard-scale': string
}

type FocusedArtifactNode = ProjectCanvasFlowNode | StoryboardWorkbenchProjectCanvasNode

const isStoryboardWorkbenchFocusedNode = (
  node: CanvasViewportExtraNode,
): node is StoryboardWorkbenchProjectCanvasNode => node.type === 'storyboard-workbench-node'

/**
 * 读取全幅产物视图中的节点类型标签。
 *
 * @param kind - 当前画布节点类型。
 * @returns 用户可读的节点类型标签。
 */
const getFocusedArtifactKindLabel = (kind: ProjectCanvasArtifactKind) =>
  FOCUSED_ARTIFACT_KIND_LABELS[kind]

/**
 * 生成书签栏中的短标题。
 *
 * @param title - 来自 session 快照归一化后的产物标题。
 * @returns 适合窄书签栏单行居中展示的短标题。
 */
const getBookmarkDisplayTitle = (title: string) => {
  const normalizedTitle = title.trim()
  const titleCharacters = Array.from(normalizedTitle)

  if (titleCharacters.length <= BOOKMARK_DISPLAY_TITLE_MAX_CHARACTERS) {
    return normalizedTitle
  }

  return titleCharacters
    .slice(0, BOOKMARK_DISPLAY_TITLE_MAX_CHARACTERS)
    .join('')
    .replace(BOOKMARK_DISPLAY_TITLE_TRAILING_SEPARATOR_PATTERN, '')
}

/**
 * 将画布缩放百分比映射成右侧产物预览缩放比例。
 *
 * @param zoomLevel - 画布 store 中的缩放百分比。
 * @returns 产物预览内容使用的 CSS zoom 倍率。
 */
const getFocusedArtifactScale = (zoomLevel: number) =>
  Math.max(
    FOCUSED_ARTIFACT_ZOOM_MIN_SCALE,
    Math.min(FOCUSED_ARTIFACT_ZOOM_MAX_SCALE, zoomLevel / FOCUSED_ARTIFACT_ZOOM_BASE_LEVEL),
  )

/**
 * 将 storyboard 画布节点宽度映射到右侧书签页宽度。
 *
 * @param viewportWidth - 右侧书签页内容区宽度。
 * @returns 让固定尺寸 storyboard 节点完整落在右侧页内的缩放比例。
 */
const getFocusedStoryboardScale = (viewportWidth: number) => {
  const availableWidth = Math.max(0, viewportWidth)
  const rawScale = availableWidth / STORYBOARD_WORKBENCH_NODE_WIDTH

  return Math.max(FOCUSED_STORYBOARD_MIN_SCALE, Math.min(FOCUSED_STORYBOARD_MAX_SCALE, rawScale))
}

/**
 * 读取 focused artifact 节点对应的书签类型。
 *
 * @param node - 当前 focused artifact 节点。
 * @returns 普通 artifact kind；storyboard workbench 复用 storyboard 书签样式。
 */
const getFocusedArtifactNodeKind = (node: FocusedArtifactNode): ProjectCanvasArtifactKind =>
  node.type === 'storyboard-workbench-node' ? 'storyboard' : node.data.artifactKind

/**
 * 读取 focused artifact 节点标题。
 *
 * @param node - 当前 focused artifact 节点。
 * @returns 用户可读标题。
 */
const getFocusedArtifactNodeTitle = (node: FocusedArtifactNode) => node.data.title

/**
 * 将画布节点 id 转成 Markdown renderer 可用的稳定 identity。
 *
 * @param nodeId - 当前画布节点 id。
 * @returns 可用作 Markdown renderer identity 的安全字符串。
 */
const createFocusedMarkdownIdentity = (nodeId: string) => {
  const normalizedNodeId = nodeId
    .toLowerCase()
    .replaceAll(MARKDOWN_IDENTITY_INVALID_CHARACTERS_PATTERN, '-')
    .replaceAll(MARKDOWN_IDENTITY_EDGE_SEPARATOR_PATTERN, '')

  return `focused-artifact-markdown-${normalizedNodeId || 'node'}`
}

/**
 * 将 Markdown 来源视频转换为媒体预览项。
 *
 * @param sourceVideo - Markdown artifact 关联的视频媒体。
 * @returns 可交给媒体预览弹窗消费的视频预览数据。
 */
const focusedMarkdownSourceVideoToPreviewItem = (
  sourceVideo: MarkdownArtifactSourceMedia,
): MediaPreviewItem => {
  const fileName = sourceVideo.filename ?? sourceVideo.key

  return {
    attachmentId: sourceVideo.key,
    fileName,
    mediaType: 'video',
    thumbnailUrl: sourceVideo.thumbnailUrl,
    url: sourceVideo.url,
  }
}

/**
 * 阻止来源视频交互触发画布拖拽。
 *
 * @param event - 来源视频按钮的指针事件。
 */
const stopFocusedSourceVideoPointerPropagation = (event: { stopPropagation: () => void }) => {
  event.stopPropagation()
}

/**
 * 生成静态首帧预览用的视频 URL。
 *
 * @param url - 来源视频 URL。
 * @returns 带首帧时间片段的视频 URL。
 */
const createFocusedSourceVideoPosterUrl = (url: string) =>
  url.includes('#') ? url : `${url}#t=0.001`

/**
 * 读取节点详情头部的内容摘要。
 *
 * @param node - 当前 focused artifact 节点。
 * @returns 与产物内容对应的短摘要。
 */
const getFocusedArtifactSummary = (node: FocusedArtifactNode) => {
  switch (node.type) {
    case 'brief-node':
      return '创意策略'
    case 'image-analysis-summary-node':
      return `${node.data.imageAnalysisSummary.items.length.toString()} 张图片`
    case 'markdown-node':
      return 'Markdown'
    case 'storyboard-node':
      return `${(node.data.storyboard.shotTable?.length ?? 0).toString()} 个镜头`
    case 'storyboard-workbench-node':
      return `${node.data.shots.length.toString()} 个镜头`
    case 'ui-card-node':
      return `${node.data.uiCard.sections.length.toString()} 个区块`
    case 'video-prompt-node':
      return `${node.data.videoPrompt.batches.length.toString()} 条提示词`
    default: {
      const exhaustiveCheck: never = node
      return exhaustiveCheck
    }
  }
}

function FocusedArtifactIcon({ kind }: { kind: ProjectCanvasArtifactKind }) {
  const iconName = BOOKMARK_ICON_BY_KIND[kind]

  return (
    <span
      aria-hidden="true"
      className="relative inline-flex size-8 items-center justify-center transition-transform duration-150"
    >
      <HippoIcon
        className="absolute translate-x-[0.7px] translate-y-[0.8px] text-[var(--color-outline)] opacity-70"
        name={iconName}
        size={BOOKMARK_ICON_SIZE}
      />
      <HippoIcon
        className="relative text-[var(--color-surface)]"
        data-project-canvas-bookmark-icon="true"
        name={iconName}
        size={BOOKMARK_ICON_SIZE}
      />
    </span>
  )
}

/**
 * 渲染全幅产物内容的通用外框。
 *
 * @param props - 外框属性。
 * @param props.children - 具体产物渲染器。
 * @returns 占满内容区的产物外框。
 */
function FocusedArtifactSurface({ children }: FocusedArtifactSurfaceProps) {
  return (
    <div className="h-full min-h-0 overflow-hidden rounded-l-xl rounded-r-none border border-[var(--color-border)] bg-[var(--color-canvas-card-bg)] shadow-[var(--shadow-3)]">
      {children}
    </div>
  )
}

/**
 * 渲染 Markdown 节点的全幅正文。
 *
 * @param props - Markdown 全幅视图属性。
 * @param props.node - 当前 Markdown 画布节点。
 * @returns 使用 expanded-preview 的 Markdown 阅读区。
 */
function FocusedArtifactMarkdownView({ node }: FocusedArtifactMarkdownViewProps) {
  const identity = useMemo(() => createFocusedMarkdownIdentity(node.id), [node.id])
  const sourceVideo =
    node.data.markdown.sourceMedia?.kind === 'video' ? node.data.markdown.sourceMedia : undefined
  const shotByShotScript = useMemo(
    () => parseShotByShotScriptMarkdown(node.data.markdown.markdown),
    [node.data.markdown.markdown],
  )
  const { closePreview, openPreview, preview } = useMediaPreview()

  return (
    <>
      {shotByShotScript ? (
        <ShotByShotScriptCanvasCard
          markdown={node.data.markdown}
          script={shotByShotScript}
          variant="focused"
        />
      ) : (
        <div
          className="min-h-full rounded-l-xl rounded-r-none border border-[var(--color-border)] bg-[var(--color-background)] text-[var(--color-on-background)]"
          data-project-canvas-markdown-preview="true"
        >
          {sourceVideo ? (
            <FocusedMarkdownSourceVideoBanner onPreview={openPreview} sourceVideo={sourceVideo} />
          ) : null}
          <RichMarkdownRenderer
            className="rich-markdown-focused-artifact-body"
            identity={identity}
            markdown={node.data.markdown.markdown}
            variant="expanded-preview"
          />
        </div>
      )}
      {preview ? (
        <MediaPreviewDialog
          key={`${preview.mediaType}:${preview.attachmentId ?? preview.url}`}
          onClose={closePreview}
          preview={preview}
        />
      ) : null}
    </>
  )
}

/**
 * 渲染全幅 Markdown 顶部的来源视频。
 *
 * @param props - 来源视频横幅属性。
 * @param props.onPreview - 打开媒体预览的回调。
 * @param props.sourceVideo - 当前 Markdown artifact 关联的视频媒体。
 * @returns 位于文档正文上方的参考视频入口。
 */
function FocusedMarkdownSourceVideoBanner({
  onPreview,
  sourceVideo,
}: {
  onPreview: (preview: MediaPreviewItem) => void
  sourceVideo: MarkdownArtifactSourceMedia
}) {
  const fileName = sourceVideo.filename ?? sourceVideo.key

  return (
    <button
      aria-label={`播放参考视频 ${fileName}`}
      className={FOCUSED_MARKDOWN_SOURCE_VIDEO_CLASS}
      onClick={(event) => {
        event.stopPropagation()
        onPreview(focusedMarkdownSourceVideoToPreviewItem(sourceVideo))
      }}
      onPointerDown={stopFocusedSourceVideoPointerPropagation}
      title={`播放参考视频 ${fileName}`}
      type="button"
    >
      <video
        className="absolute inset-0 h-full w-full scale-[1.02] object-cover object-center transition-transform duration-200 group-hover:scale-[1.05]"
        muted
        playsInline
        poster={sourceVideo.thumbnailUrl}
        preload="metadata"
        src={createFocusedSourceVideoPosterUrl(sourceVideo.url)}
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[image:var(--media-scrim-cover)]"
      />
      <span className="pointer-events-none absolute inset-x-5 bottom-4 flex items-end justify-between gap-4">
        <span className="min-w-0">
          <span className="block text-caption font-medium tracking-[0.18em] text-white/58 uppercase">
            参考视频
          </span>
          <span className="mt-1 block truncate text-title leading-tight font-semibold text-white">
            {fileName}
          </span>
        </span>
        <span className="grid size-9 shrink-0 place-items-center rounded-full border border-white/24 bg-white/16 text-white shadow-[var(--shadow-2)] backdrop-blur-md transition-transform duration-150 group-hover:scale-[1.04]">
          <HippoIcon name="browse" size={16} />
        </span>
      </span>
    </button>
  )
}

/**
 * 在右侧 focused artifact 中渲染复用的 storyboard workbench 节点。
 *
 * @param props - focused storyboard workbench 属性。
 * @param props.node - 直接生成链路创建的 storyboard workbench 节点。
 * @returns 不参与 React Flow 的 storyboard workbench 预览。
 */
function FocusedArtifactStoryboardWorkbenchView({
  node,
}: {
  node: StoryboardWorkbenchProjectCanvasNode
}) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const [storyboardScale, setStoryboardScale] = useState(FOCUSED_STORYBOARD_INITIAL_SCALE)
  const nodeProps = {
    data: node.data,
    focusedPreview: true,
    id: node.id,
    selected: false,
  } satisfies ComponentProps<typeof StoryboardWorkbenchCanvasNode>
  const scaledHeight = Math.ceil(STORYBOARD_WORKBENCH_NODE_HEIGHT * storyboardScale)
  const storyboardStyle: FocusedArtifactStoryboardWorkbenchStyle = {
    '--layout-project-focused-storyboard-height': `${scaledHeight.toString()}px`,
    '--layout-project-focused-storyboard-scale': storyboardScale.toString(),
    height: 'var(--layout-project-focused-storyboard-height)',
  }

  useLayoutEffect(() => {
    const viewportElement = viewportRef.current

    if (!viewportElement) {
      return
    }

    const syncStoryboardScale = () => {
      const { width } = viewportElement.getBoundingClientRect()

      if (!Number.isFinite(width) || width <= 0) {
        return
      }

      const nextScale = getFocusedStoryboardScale(width)
      setStoryboardScale((currentScale) => (currentScale === nextScale ? currentScale : nextScale))
    }

    syncStoryboardScale()

    if (typeof ResizeObserver === 'undefined') {
      return
    }

    const resizeObserver = new ResizeObserver(syncStoryboardScale)
    resizeObserver.observe(viewportElement)

    return () => {
      resizeObserver.disconnect()
    }
  }, [])

  return (
    <div
      className="thin-scrollbar h-full min-h-0 overflow-x-hidden overflow-y-auto rounded-l-xl rounded-r-none border border-[var(--color-border)] shadow-[var(--shadow-3)]"
      data-project-canvas-focused-storyboard-viewport="true"
      ref={viewportRef}
      style={FOCUSED_STORYBOARD_SURFACE_STYLE}
    >
      <div
        className="relative w-full"
        data-project-canvas-focused-storyboard-frame="true"
        style={storyboardStyle}
      >
        <div
          className="origin-top-left"
          data-project-canvas-focused-storyboard-scaled-node="true"
          style={{
            height: STORYBOARD_WORKBENCH_NODE_HEIGHT,
            transform: 'scale(var(--layout-project-focused-storyboard-scale))',
            width: STORYBOARD_WORKBENCH_NODE_WIDTH,
          }}
        >
          <StoryboardWorkbenchCanvasNode {...nodeProps} />
        </div>
      </div>
    </div>
  )
}

/**
 * 渲染 Agent 视频提示词节点的全幅内容。
 *
 * @param props - 视频提示词全幅视图属性。
 * @param props.node - 当前视频提示词画布节点。
 * @returns 带 Agent session-scoped 提交回调的视频提示词全幅内容。
 */
function FocusedArtifactVideoPromptView({ node }: FocusedArtifactVideoPromptViewProps) {
  const { isInteractionLocked, saveVideoPrompt, submitVideoGenerations, submitVideoGeneration } =
    useProjectChatVideoGeneration()

  return (
    <FocusedArtifactSurface>
      <VideoPromptCanvasCard
        generatedVideo={node.data.generatedVideo}
        isVideoGenerationDisabled={isInteractionLocked}
        onSavePrompt={saveVideoPrompt}
        onSubmitVideoGenerations={submitVideoGenerations}
        onSubmitVideoGeneration={submitVideoGeneration}
        videoPrompt={node.data.videoPrompt}
      />
    </FocusedArtifactSurface>
  )
}

/**
 * 按节点类型渲染全幅产物内容。
 *
 * @param props - 产物内容属性。
 * @param props.node - 当前选中的 focused artifact 节点。
 * @returns 当前节点对应的全幅阅读视图。
 */
function FocusedArtifactContent({ node }: { node: FocusedArtifactNode }) {
  switch (node.type) {
    case 'brief-node':
      return (
        <FocusedArtifactSurface>
          <CreativeBriefCanvasCard brief={node.data.brief} />
        </FocusedArtifactSurface>
      )
    case 'image-analysis-summary-node':
      return (
        <ImageAnalysisSummaryCanvasCard
          summary={node.data.imageAnalysisSummary}
          variant="focused"
        />
      )
    case 'markdown-node':
      return <FocusedArtifactMarkdownView node={node} />
    case 'storyboard-node':
      return (
        <FocusedArtifactSurface>
          <StoryboardCanvasCard storyboard={node.data.storyboard} />
        </FocusedArtifactSurface>
      )
    case 'storyboard-workbench-node':
      return <FocusedArtifactStoryboardWorkbenchView node={node} />
    case 'ui-card-node':
      return (
        <FocusedArtifactSurface>
          <UiCardCanvasBody uiCard={node.data.uiCard} />
        </FocusedArtifactSurface>
      )
    case 'video-prompt-node':
      return <FocusedArtifactVideoPromptView node={node} />
    default: {
      const exhaustiveCheck: never = node
      return exhaustiveCheck
    }
  }
}

/**
 * 渲染项目页右侧的产物书签和预览层。
 *
 * @param props - 产物书签层属性。
 * @param props.leftOffset - 左侧聊天面板占用后，预览层需要避让的距离。
 * @returns 选中产物的预览视图；没有产物时返回 null。
 */
export default function ProjectCanvasFocusedArtifact({
  extraArtifactNodes = [],
  leftOffset,
}: ProjectCanvasFocusedArtifactProps) {
  const canvasNodes = useProjectCanvasStore((state) => state.nodes)
  const selectedNodeId = useProjectCanvasStore((state) => state.selectedNodeId)
  const selectNode = useProjectCanvasStore((state) => state.selectNode)
  const zoomLevel = useProjectCanvasStore((state) => state.zoomLevel)
  const focusedExtraNodes = useMemo(
    () => extraArtifactNodes.filter(isStoryboardWorkbenchFocusedNode),
    [extraArtifactNodes],
  )
  const nodes = useMemo<FocusedArtifactNode[]>(
    () => (focusedExtraNodes.length > 0 ? [...canvasNodes, ...focusedExtraNodes] : canvasNodes),
    [canvasNodes, focusedExtraNodes],
  )
  const activeNode = selectedNodeId
    ? (nodes.find((node) => node.id === selectedNodeId) ?? null)
    : (nodes.at(-1) ?? null)
  const activeNodeKind = activeNode ? getFocusedArtifactNodeKind(activeNode) : null
  const focusedArtifactScale =
    activeNode?.type === 'storyboard-workbench-node' ? 1 : getFocusedArtifactScale(zoomLevel)
  const artifactScaleSurfaceClassName = cn(
    'w-full origin-top-left [zoom:var(--layout-project-focused-artifact-scale)]',
    activeNode?.type === 'storyboard-workbench-node' ? 'h-full' : null,
  )
  const style: ProjectCanvasFocusedArtifactStyle = {
    '--layout-project-focused-artifact-left': leftOffset,
    '--layout-project-focused-artifact-scale': focusedArtifactScale.toString(),
  }

  if (!activeNode) {
    return null
  }

  return (
    <section
      aria-label="项目产物书签预览"
      className="layer-canvas-overlay pointer-events-none absolute top-[var(--layout-project-header-height)] right-0 bottom-0 left-0"
      data-project-canvas-focused-artifact="true"
      style={style}
    >
      <div className="[margin-left:var(--layout-project-focused-artifact-left)] flex h-full min-h-0 items-stretch">
        <aside
          className="pointer-events-auto flex h-full min-h-0 min-w-0 flex-1 overflow-hidden"
          data-project-canvas-bookmark-panel="true"
        >
          <div className="flex min-w-0 flex-1 flex-col">
            <span
              aria-hidden="true"
              className="ml-5 block h-[3px] w-[calc(100%-40px)] shrink-0 rounded-full transition-colors duration-300"
              data-project-canvas-artifact-accent-line="true"
              style={{
                backgroundColor: activeNodeKind ? BOOKMARK_KIND_COLORS[activeNodeKind] : undefined,
              }}
            />
            <section
              aria-label={`${getFocusedArtifactNodeTitle(activeNode)} ${getFocusedArtifactKindLabel(getFocusedArtifactNodeKind(activeNode))}预览，${getFocusedArtifactSummary(activeNode)}`}
              className="thin-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain px-0 py-0"
              data-project-canvas-artifact-scroll="true"
              data-scrollable
            >
              <div
                className={artifactScaleSurfaceClassName}
                data-project-canvas-artifact-scale-surface="true"
              >
                <FocusedArtifactContent node={activeNode} />
              </div>
            </section>
          </div>
        </aside>

        <nav
          aria-label="产物书签"
          className="thin-scrollbar pointer-events-auto flex max-h-full w-[82px] shrink-0 flex-col items-center gap-5 overflow-y-auto border-y border-l border-white/[0.24] bg-[var(--color-artifact-rail-bg)] px-[10px] py-6"
          data-project-canvas-bookmark-rail="true"
        >
          {nodes.map((node) => {
            const active = node.id === activeNode.id
            const nodeKind = getFocusedArtifactNodeKind(node)
            const nodeTitle = getFocusedArtifactNodeTitle(node)
            const kindColor = BOOKMARK_KIND_COLORS[nodeKind]
            const bookmarkDisplayTitle = getBookmarkDisplayTitle(nodeTitle)

            return (
              <button
                aria-label={`预览${nodeTitle}`}
                aria-pressed={active}
                className={cn(
                  'relative flex w-[62px] shrink-0 flex-col items-center justify-center gap-0.5 border transition-all duration-200 ease-out active:scale-95',
                  active
                    ? 'h-[86px] rounded-l-xl rounded-r-none border-r-0 border-white/[0.12] text-white shadow-[var(--shadow-2)]'
                    : 'h-[82px] rounded-xl border-transparent bg-transparent text-white/84 hover:bg-white/[0.05] hover:text-white',
                )}
                data-project-canvas-bookmark-button="true"
                key={node.id}
                onClick={() => selectNode(node.id)}
                style={
                  active
                    ? {
                        backgroundColor: `color-mix(in srgb, ${kindColor} 18%, var(--color-artifact-rail-bg))`,
                      }
                    : undefined
                }
                title={nodeTitle}
                type="button"
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    'absolute top-1/2 left-0 w-[3px] -translate-y-1/2 rounded-r-full transition-all duration-200',
                    active ? 'h-[36px]' : 'h-[20px] opacity-60',
                  )}
                  style={{ backgroundColor: kindColor }}
                />
                <FocusedArtifactIcon kind={nodeKind} />
                <span
                  className={cn(
                    'block max-w-full truncate text-center text-caption leading-tight font-medium',
                    active ? 'text-white/90' : 'text-white/50',
                  )}
                >
                  {bookmarkDisplayTitle}
                </span>
              </button>
            )
          })}
        </nav>
      </div>
    </section>
  )
}
