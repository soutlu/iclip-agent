import type { NodeTypes } from '@xyflow/react'
import type { CSSProperties, ReactNode } from 'react'
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ProjectChatComposer, ProjectChatPanel } from '@/features/chat'
import {
  CanvasViewport,
  type CanvasViewportExtraNode,
  ProjectCanvasFocusedArtifact,
} from '@/features/project-canvas'
import ZoomControls from '@/features/project-workspace/components/ZoomControls'
import { useProjectLayoutStore } from '@/features/project-workspace/state/project-layout-store'

const PROJECT_COMPOSER_PANEL_BASE_RESERVE_PX = 180

interface ProjectCanvasStageProps {
  composerSlot?: ReactNode
  enableCanvasViewportZoom?: boolean
  extraCanvasNodeTypes?: NodeTypes
  extraCanvasNodes?: CanvasViewportExtraNode[]
  showBottomRightControls?: boolean
  showComposer?: boolean
  showExtraCanvasNodes?: boolean
  showFocusedArtifact?: boolean
  showOutputPanel?: boolean
  showProjectNodes?: boolean
}

type ProjectCanvasStageStyle = CSSProperties & {
  '--layout-project-chat-panel-bottom-safe-area': string
  '--layout-project-chat-panel-height-offset': string
  '--layout-project-composer-panel-reserve': string
}

/**
 * 读取桌面 composer 当前高度，并保留设计系统约定的基础安全高度。
 *
 * @param composerElement - 包裹底部 composer 的舞台节点。
 * @returns 输出面板需要避让的 composer 高度像素值。
 */
const getProjectComposerPanelReserve = (composerElement: HTMLDivElement | null) => {
  if (!composerElement) {
    return PROJECT_COMPOSER_PANEL_BASE_RESERVE_PX
  }

  const measuredHeight = Math.ceil(composerElement.getBoundingClientRect().height)

  return Math.max(PROJECT_COMPOSER_PANEL_BASE_RESERVE_PX, measuredHeight)
}

/**
 * 创建桌面舞台共享给浮动输出面板的布局变量。
 *
 * @param composerPanelReserve - 当前 composer 需要占用的底部安全高度。
 * @param showComposer - 当前舞台是否展示底部 composer。
 * @returns 可写入舞台根节点的 CSS 自定义属性。
 */
const createProjectCanvasStageStyle = (
  composerPanelReserve: number,
  showComposer: boolean,
): ProjectCanvasStageStyle => ({
  '--layout-project-chat-panel-bottom-safe-area': showComposer
    ? 'calc(var(--layout-project-stage-padding) + var(--layout-project-composer-panel-reserve) + var(--layout-project-stage-padding))'
    : 'var(--layout-project-stage-padding)',
  '--layout-project-chat-panel-height-offset':
    'calc(var(--layout-project-header-height) + var(--layout-project-stage-padding) + var(--layout-project-chat-panel-bottom-safe-area))',
  '--layout-project-composer-panel-reserve': `${composerPanelReserve}px`,
})

/**
 * 监听桌面 composer 高度变化，让左侧浮动输出面板实时避让底部输入框。
 *
 * @param showComposer - 当前舞台是否展示底部 composer。
 * @returns composer 容器 ref 和舞台根节点布局变量。
 */
const useProjectComposerPanelReserve = (showComposer: boolean) => {
  const composerContainerRef = useRef<HTMLDivElement>(null)
  const [composerPanelReserve, setComposerPanelReserve] = useState(() =>
    showComposer ? PROJECT_COMPOSER_PANEL_BASE_RESERVE_PX : 0,
  )

  useLayoutEffect(() => {
    if (!showComposer) {
      setComposerPanelReserve(0)
      return
    }

    const composerElement = composerContainerRef.current

    if (!composerElement) {
      setComposerPanelReserve(PROJECT_COMPOSER_PANEL_BASE_RESERVE_PX)
      return
    }

    const syncComposerPanelReserve = () => {
      const nextReserve = getProjectComposerPanelReserve(composerElement)

      setComposerPanelReserve((currentReserve) =>
        currentReserve === nextReserve ? currentReserve : nextReserve,
      )
    }

    syncComposerPanelReserve()

    if (typeof ResizeObserver === 'undefined') {
      return
    }

    const resizeObserver = new ResizeObserver(syncComposerPanelReserve)
    resizeObserver.observe(composerElement)

    return () => {
      resizeObserver.disconnect()
    }
  }, [showComposer])

  const stageStyle = useMemo(
    () => createProjectCanvasStageStyle(composerPanelReserve, showComposer),
    [composerPanelReserve, showComposer],
  )

  return { composerContainerRef, stageStyle }
}

/**
 * 渲染项目画布舞台和浮动控制层。
 *
 * @param props - 画布舞台展示选项。
 * @param props.composerSlot - 自定义底部输入框；缺省时使用 Agent chat composer。
 * @param props.enableCanvasViewportZoom - 是否允许滚轮和触控板缩放画布。
 * @param props.extraCanvasNodeTypes - 按页面注入的额外 React Flow 节点组件。
 * @param props.extraCanvasNodes - 按页面注入的额外 React Flow 节点数据。
 * @param props.showBottomRightControls - 是否展示右下角缩放控件。
 * @param props.showComposer - 是否展示底部输入框。
 * @param props.showExtraCanvasNodes - 是否把 extraCanvasNodes 渲染到 React Flow 画布。
 * @param props.showFocusedArtifact - 是否展示产物 focused 预览层。
 * @param props.showOutputPanel - 是否展示左侧输出面板。
 * @param props.showProjectNodes - 是否把 project-canvas store 中的节点渲染到画布。
 * @returns 项目画布舞台元素。
 */
export default function ProjectCanvasStage({
  composerSlot,
  enableCanvasViewportZoom = false,
  extraCanvasNodeTypes,
  extraCanvasNodes,
  showBottomRightControls = true,
  showComposer = false,
  showExtraCanvasNodes = true,
  showFocusedArtifact = true,
  showOutputPanel = true,
  showProjectNodes = true,
}: ProjectCanvasStageProps) {
  const { composerContainerRef, stageStyle } = useProjectComposerPanelReserve(showComposer)
  const sidebarWidth = useProjectLayoutStore((state) => state.sidebarWidth)
  const focusedArtifactLeftOffset = showOutputPanel
    ? `calc(${sidebarWidth.toString()}px + var(--layout-project-stage-padding))`
    : 'var(--layout-project-stage-padding)'

  return (
    <section className="relative h-full min-w-0 flex-1 overflow-hidden" style={stageStyle}>
      <div className="relative h-full w-full">
        <div className="absolute inset-0 overflow-hidden">
          <CanvasViewport
            enableViewportZoom={enableCanvasViewportZoom}
            extraNodeTypes={extraCanvasNodeTypes}
            extraNodes={showExtraCanvasNodes ? extraCanvasNodes : []}
            showProjectNodes={showProjectNodes}
          />
        </div>

        <div
          className="project-header-gradient layer-panel pointer-events-none absolute inset-x-0 top-0"
          aria-hidden="true"
        />

        {showOutputPanel && (
          <div
            className="layer-sidebar pointer-events-none absolute top-[var(--layout-project-header-height)] bottom-0 left-0"
            data-project-output-panel="true"
          >
            <div className="pointer-events-auto h-full">
              <ProjectChatPanel floating panelWidth={sidebarWidth} />
            </div>
          </div>
        )}

        {showFocusedArtifact ? (
          <ProjectCanvasFocusedArtifact
            extraArtifactNodes={extraCanvasNodes}
            leftOffset={focusedArtifactLeftOffset}
          />
        ) : null}

        {showBottomRightControls && (
          <div className="layer-header pointer-events-none absolute right-[var(--layout-project-stage-padding)] bottom-[var(--layout-project-stage-padding)]">
            <div className="pointer-events-auto">
              <ZoomControls />
            </div>
          </div>
        )}

        {showComposer && (
          <div
            className="layer-header pointer-events-none absolute bottom-[var(--layout-project-stage-padding)] left-1/2 -translate-x-1/2"
            data-project-composer-safe-area="true"
            ref={composerContainerRef}
          >
            <div className="pointer-events-auto flex flex-col items-center">
              {composerSlot ?? <ProjectChatComposer />}
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
