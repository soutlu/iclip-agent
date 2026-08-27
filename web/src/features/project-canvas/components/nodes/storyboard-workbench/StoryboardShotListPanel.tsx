import { type ChangeEvent, type KeyboardEvent, type MouseEvent, useRef } from 'react'
import { VideoGenerationStatusTile } from '@/features/project-canvas/components/nodes/video-generation-status-ui'
import { cn } from '@/shared/lib/utils'
import {
  StoryboardAddScreenIcon,
  StoryboardDividerIcon,
  StoryboardMoreIcon,
  StoryboardNarratorIcon,
  StoryboardScreenToolIcon,
  type StoryboardScreenToolIconType,
  StoryboardTitleIcon,
  StoryboardToggleIcon,
} from './storyboard-workbench-icons'
import {
  SCREEN_TOOL_ITEMS,
  STORYBOARD_NODE_SURFACE_STYLE,
  STORYBOARD_SCRIPT_PANEL_WIDTH,
  STORYBOARD_SHOT_IMAGE_FILE_ACCEPT,
} from './storyboard-workbench.constants'
import type {
  StoryboardWorkbenchAddShotInput,
  StoryboardWorkbenchShotItemProps,
  StoryboardWorkbenchShotListProps,
  StoryboardWorkbenchShotMaterialProps,
  StoryboardWorkbenchTitleTagProps,
} from './storyboard-workbench.types'
import {
  createEmptyShot,
  createStoryboardRedoShotInput,
  downloadStoryboardShotMedia,
  formatCoverDuration,
  formatShotDuration,
  getRenderableShots,
  getShotDurationSeconds,
  isStoryboardEmptyShot,
  stringifyDropPayload,
} from './storyboard-workbench.utils'

/**
 * 渲染节点标题标签。
 *
 * @param props - 标题标签属性。
 * @param props.onToggleViewMode - 视图切换回调。
 * @param props.title - 节点标题。
 * @param props.viewMode - 当前视图模式。
 * @returns 位于节点外上方的标题条。
 */
export function StoryboardWorkbenchTitleTag({
  onToggleViewMode,
  title,
  viewMode,
}: StoryboardWorkbenchTitleTagProps) {
  const handleToggle = (event: MouseEvent<HTMLDivElement>) => {
    event.stopPropagation()
    onToggleViewMode()
  }
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    onToggleViewMode()
  }

  return (
    <div
      aria-label="Toggle storyboard view mode"
      aria-pressed={viewMode === 'screen'}
      className="node-specific-title-tag-itc0VR nodrag nopan flex items-center gap-[16px]"
      data-storyboard-workbench-title-tag="true"
      data-storyboard-workbench-view-mode={viewMode}
      onClick={handleToggle}
      onKeyDown={handleKeyDown}
      onPointerDown={(event) => event.stopPropagation()}
      role="button"
      style={{
        bottom: '100%',
        cursor: 'pointer',
        left: 0,
        position: 'absolute',
        zIndex: 'var(--z-panel)',
      }}
      tabIndex={0}
    >
      <div className="node-specific-title-content-caj6Zi flex h-[75px] items-center gap-[16px] px-[21px] text-[var(--storyboard-node-muted-strong)]">
        <StoryboardTitleIcon size={32} />
        <span
          className="node-specific-title-text-X4HE2P max-w-[363px] truncate text-headline-lg font-medium"
          title={title}
        >
          {title}
        </span>
      </div>
      <div className="titleToggleContainer-k6GM0c grid h-[75px] w-[75px] place-items-center text-[var(--storyboard-node-ink)]">
        <StoryboardToggleIcon size={32} viewMode={viewMode} />
      </div>
    </div>
  )
}

/**
 * 渲染参考节点的加号分割线。
 *
 * @param props - 分割线属性。
 * @param props.isScreenMode - 是否为参考节点的 simpleViewerMode。
 * @param props.nodeId - 节点 id。
 * @param props.onAddShot - 点击添加按钮时通知外层新增镜头。
 * @param props.shotId - 镜头 id。
 * @returns 镜头之间的线性添加器。
 */
function StoryboardShotDivider({
  isScreenMode = false,
  nodeId,
  onAddShot,
  shotId,
}: {
  isScreenMode?: boolean
  nodeId: string
  onAddShot?: (input: StoryboardWorkbenchAddShotInput) => void
  shotId: string
}) {
  const handleAddShot = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()

    if (!onAddShot) {
      throw new Error('Storyboard add shot requires an onAddShot handler.')
    }

    onAddShot({ afterShotId: shotId })
  }

  return (
    <div
      className="group/storyboard-shot-divider w-full"
      data-node-id={nodeId}
      data-payload={stringifyDropPayload({
        dividerPosition: 'bottom',
        hoverType: 'SHOT_DIVIDER',
        nodeId,
        shotId,
      })}
      data-storyboard-workbench-shot-divider="true"
      data-type="free-drop"
    >
      <div
        className={cn(
          'dividerWrapper-bczEf4',
          isScreenMode ? 'sw-simple-viewer-mode' : '',
          'isLast-W1pMbo',
        )}
      >
        <button
          aria-label="在下方添加视频块"
          className="linearAdder-aDQKU3 bottom-VKsymM nodrag nopan relative block h-[53px] w-full cursor-pointer appearance-none border-0 bg-transparent p-0"
          data-storyboard-workbench-add-shot-button="true"
          onClick={handleAddShot}
          onPointerDown={(event) => event.stopPropagation()}
          type="button"
        >
          <StoryboardDividerIcon
            className="dividerIcon-hDkXXA layer-local-1 pointer-events-none absolute top-0 left-[37px] opacity-0 transition-opacity ui-motion-s group-focus-within/storyboard-shot-divider:opacity-100 group-hover/storyboard-shot-divider:opacity-100"
            size={53}
          />
          <span className="dividerLine-sqMDkc pointer-events-none absolute top-[24px] right-[32px] left-[91px] h-[3px] bg-[var(--storyboard-node-accent-line)] opacity-0 transition-opacity ui-motion-s group-focus-within/storyboard-shot-divider:opacity-100 group-hover/storyboard-shot-divider:opacity-100" />
        </button>
      </div>
    </div>
  )
}

/**
 * 渲染单个素材格。
 *
 * @param props - 素材格属性。
 * @param props.media - 素材数据。
 * @param props.nodeId - 节点 id。
 * @param props.shotId - 镜头 id。
 * @returns 参考节点的素材上传区域。
 */
function StoryboardWorkbenchShotMaterial({
  nodeAspectRatio,
  nodeId,
  onRedoShot,
  onUploadShotMedia,
  shot,
}: StoryboardWorkbenchShotMaterialProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const media = shot.media[0] ?? null
  const mediaSource = media?.thumbnailUrl ?? media?.url
  const generationStatus = shot.status === 'draft' ? null : shot.status
  const isGenerationStatusEmptyShot = generationStatus !== null && !media
  const isRedoableFailedShot = generationStatus === 'failed' && !media
  const redoShot = () => {
    if (!onRedoShot) {
      throw new Error('Storyboard redo tool requires an onRedoShot handler.')
    }

    onRedoShot(createStoryboardRedoShotInput({ nodeAspectRatio, shot }))
  }
  const handleRedoShotClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    redoShot()
  }
  const handleRedoShotKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    redoShot()
  }
  const handleToolClick = (
    event: MouseEvent<HTMLButtonElement>,
    toolId: StoryboardScreenToolIconType,
  ) => {
    event.preventDefault()
    event.stopPropagation()

    if (toolId === 'redo') {
      handleRedoShotClick(event)
      return
    }

    if (toolId === 'download') {
      if (!media) {
        throw new Error(`Storyboard shot ${shot.id} does not have media to download.`)
      }

      void downloadStoryboardShotMedia(media).catch(() => undefined)
    }
  }
  const handleUploadButtonClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
    fileInputRef.current?.click()
  }
  const handleUploadInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = Array.from(event.currentTarget.files ?? [])
    event.currentTarget.value = ''

    if (selectedFiles.length === 0) {
      return
    }

    if (!onUploadShotMedia) {
      throw new Error('Storyboard shot upload requires an onUploadShotMedia handler.')
    }

    void onUploadShotMedia({
      files: selectedFiles,
      shotId: shot.id,
    })
  }

  return (
    <div className="sw-material sw-shot-material">
      <div>
        <div className="sw-uploader-root sw-uploader">
          <input
            accept={STORYBOARD_SHOT_IMAGE_FILE_ACCEPT}
            multiple
            onChange={handleUploadInputChange}
            ref={fileInputRef}
            style={{ display: 'none' }}
            type="file"
          />
          <div
            data-node-id={nodeId}
            data-payload={stringifyDropPayload({
              hoverType: 'SHOT_BROLL',
              nodeId,
              shotId: shot.id,
            })}
            data-type="free-drop"
          >
            <div
              className={cn(
                'sw-screen group/screen',
                media ? 'sw-screen-filled' : 'sw-screen-empty',
              )}
            >
              {media && mediaSource ? (
                <div className="cover-gm6Gt8 absolute inset-0">
                  <div className="coverBackground-hzj8xb absolute inset-0 bg-[var(--storyboard-node-cover-bg)]" />
                  <div className="coverForeground-NSICv5 absolute inset-0">
                    <img alt="" className="h-full w-full object-cover" src={mediaSource} />
                  </div>
                  {typeof media.durationSeconds === 'number' &&
                  Number.isFinite(media.durationSeconds) ? (
                    <div className="coverDuration-i2XD7Z absolute right-[11px] bottom-[11px] rounded-md bg-black/65 px-[16px] py-[5px] text-canvas-title-lg leading-none font-medium text-white">
                      {formatCoverDuration(media.durationSeconds)}
                    </div>
                  ) : null}
                </div>
              ) : null}
              {media ? null : (
                <div className="sw-empty-screen">
                  {isGenerationStatusEmptyShot ? (
                    isRedoableFailedShot ? (
                      <button
                        aria-label={`重新生成镜头 ${shot.shotIndex.toString()}`}
                        className={cn(
                          'nodrag nopan block h-full w-full appearance-none border-0 bg-transparent p-0 text-left transition',
                          onRedoShot
                            ? 'cursor-pointer hover:opacity-95 active:scale-[0.985]'
                            : 'cursor-not-allowed opacity-50',
                        )}
                        data-storyboard-workbench-failed-redo-button="true"
                        data-shot-id={shot.id}
                        disabled={!onRedoShot}
                        onClick={handleRedoShotClick}
                        onKeyDown={handleRedoShotKeyDown}
                        onPointerDown={(event) => event.stopPropagation()}
                        type="button"
                      >
                        <VideoGenerationStatusTile
                          className="h-full w-full rounded-lg"
                          item={{
                            promptIndex: shot.shotIndex,
                            status: 'failed',
                          }}
                        />
                      </button>
                    ) : (
                      <VideoGenerationStatusTile
                        className="h-full w-full rounded-lg"
                        item={{
                          promptIndex: shot.shotIndex,
                          status: generationStatus,
                        }}
                      />
                    )
                  ) : onUploadShotMedia ? (
                    <button
                      aria-label={`上传镜头 ${shot.shotIndex.toString()} 图片`}
                      className="sw-add-screen nodrag nopan block h-full w-full appearance-none border-0 bg-transparent p-0 text-[inherit]"
                      data-shot-id={shot.id}
                      data-storyboard-workbench-upload-shot-button="true"
                      onClick={handleUploadButtonClick}
                      onPointerDown={(event) => event.stopPropagation()}
                      title="上传本地图片"
                      type="button"
                    >
                      <StoryboardAddScreenIcon size={43} />
                    </button>
                  ) : (
                    <div className="sw-add-screen">
                      <StoryboardAddScreenIcon size={43} />
                    </div>
                  )}
                </div>
              )}
              {media ? (
                <div
                  className="screenTools-OTBmav absolute inset-0 hidden items-center justify-center gap-4 bg-black/35 group-focus-within/screen:flex group-hover/screen:flex"
                  data-storyboard-workbench-screen-tools="true"
                >
                  {SCREEN_TOOL_ITEMS.map((tool) => {
                    const disabled =
                      tool.disabled ||
                      (tool.id === 'redo' && !onRedoShot) ||
                      (tool.id === 'download' && (!media.url || media.url.trim().length === 0))

                    return (
                      <button
                        aria-label={tool.label}
                        className={cn(
                          'toolItem-wqdq8a nodrag nopan grid h-[53px] w-[53px] place-items-center rounded-md bg-[var(--storyboard-node-selected-surface)] text-[var(--storyboard-node-ink)] transition-opacity',
                          disabled
                            ? 'cursor-not-allowed opacity-45'
                            : 'cursor-pointer hover:opacity-90 active:scale-95',
                        )}
                        data-shot-id={shot.id}
                        data-storyboard-workbench-download-url={
                          tool.id === 'download' ? media.url : undefined
                        }
                        data-storyboard-workbench-screen-tool={tool.id}
                        data-storyboard-workbench-screen-tool-disabled={
                          disabled ? 'true' : undefined
                        }
                        disabled={disabled}
                        key={tool.id}
                        onClick={(event) => handleToolClick(event, tool.id)}
                        onPointerDown={(event) => event.stopPropagation()}
                        title={tool.label}
                        type="button"
                      >
                        <StoryboardScreenToolIcon size={43} type={tool.id} />
                      </button>
                    )
                  })}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>
      <div className="dnd-area-Ix2FoW" />
    </div>
  )
}

/**
 * 渲染单条镜头。
 *
 * @param props - 镜头属性。
 * @param props.nodeId - 节点 id。
 * @param props.onSelectShot - 点击镜头时通知外层切换当前镜头。
 * @param props.shot - 镜头数据。
 * @param props.shotIndex - 镜头序号。
 * @returns 参考节点左侧列表条目。
 */
function StoryboardWorkbenchShotItem({
  isSelected,
  isScreenMode,
  nodeAspectRatio,
  nodeId,
  onRedoShot,
  onSelectShot,
  onUploadShotMedia,
  shot,
  shotIndex,
}: StoryboardWorkbenchShotItemProps) {
  const hasNarration = Boolean(shot.narration?.trim())
  const shotDurationSeconds = getShotDurationSeconds(shot)
  const hasShotDuration = shotDurationSeconds > 0
  const selectShot = () => {
    onSelectShot?.({ shotId: shot.id })
  }
  const handleShotClick = () => {
    selectShot()
  }
  const handleShotKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) {
      return
    }

    if (event.key !== 'Enter' && event.key !== ' ') {
      return
    }

    event.preventDefault()
    selectShot()
  }

  return (
    <div data-selectable-item-id={shot.id}>
      <div
        className={cn('sw-shot-item', isScreenMode && 'sw-simple-viewer-mode')}
        data-editable="true"
        data-storyboard-workbench-shot-selected={isSelected ? 'true' : undefined}
        data-storyboard-workbench-shot={shot.id}
        onClick={handleShotClick}
        onKeyDown={handleShotKeyDown}
        tabIndex={0}
      >
        <div className={cn('sw-tools', isScreenMode && 'sw-simple-viewer-mode')}>
          {isScreenMode ? null : (
            <div className="sw-tools-content">
              {isStoryboardEmptyShot(shot) || !hasShotDuration ? null : (
                <div className="sw-shot-duration">{formatShotDuration(shotDurationSeconds)}</div>
              )}
              <div>
                <div className="aroll-OzjTqU">
                  <div className="sw-empty" data-storyboard-workbench-shot-music-disabled="true">
                    <StoryboardNarratorIcon size={32} />
                    <span>添加音乐</span>
                  </div>
                  <span />
                </div>
              </div>
            </div>
          )}
        </div>
        {isScreenMode ? null : (
          <div className="sw-hover-more">
            <StoryboardMoreIcon size={43} />
          </div>
        )}
        <div className="sw-shot">
          {isScreenMode ? null : (
            <div className="sw-shot-copywriting shot-copy-writing">
              <div className="sw-editor-wrap">
                <div>
                  <div
                    className="tiptap ProseMirror sw-editor-content editor-7o9Lbm"
                    contentEditable={false}
                    data-storyboard-workbench-shot-narration-disabled="true"
                    suppressContentEditableWarning
                    tabIndex={-1}
                    translate="no"
                  >
                    {hasNarration ? (
                      <p className="ai-creator-rich-text-editor-p">{shot.narration}</p>
                    ) : (
                      <p className="ai-creator-rich-text-editor-p">
                        <br className="ProseMirror-trailingBreak" />
                      </p>
                    )}
                  </div>
                </div>
                {hasNarration ? null : (
                  <div className="sw-placeholder visible-VE2ZHv">
                    <div className="sw-editor-placeholder">
                      <span>添加旁白</span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
          <StoryboardWorkbenchShotMaterial
            nodeAspectRatio={nodeAspectRatio}
            nodeId={nodeId}
            onRedoShot={onRedoShot}
            onUploadShotMedia={onUploadShotMedia}
            shot={shot}
          />
        </div>
        <span className="sr-only">{shot.title || `Shot ${String(shotIndex + 1)}`}</span>
      </div>
    </div>
  )
}

/**
 * 渲染左侧脚本区。
 *
 * @param props - 脚本区属性。
 * @param props.activeShotId - 当前激活镜头 id。
 * @param props.isScreenMode - 是否为参考节点的 simpleViewerMode。
 * @param props.nodeId - 节点 id。
 * @param props.shots - 镜头列表。
 * @returns 参考节点的 script-area。
 */
export function StoryboardWorkbenchShotList({
  activeShotId,
  aspectRatio,
  isScreenMode,
  nodeId,
  onAddShot,
  onRedoShot,
  onSelectShot,
  onUploadShotMedia,
  shots,
}: StoryboardWorkbenchShotListProps) {
  const renderableShots = getRenderableShots(shots)
  const lastShot = renderableShots.at(-1) ?? createEmptyShot()
  const selectedShotId = activeShotId

  return (
    <div
      className="script-area-UgIHYC h-full min-w-0 flex-1"
      data-storyboard-workbench-script-panel="true"
      style={{
        ...STORYBOARD_NODE_SURFACE_STYLE,
        flex: isScreenMode ? undefined : `0 0 ${STORYBOARD_SCRIPT_PANEL_WIDTH}px`,
        width: isScreenMode ? undefined : STORYBOARD_SCRIPT_PANEL_WIDTH,
      }}
    >
      <div
        aria-expanded="false"
        className={cn(
          'scriptListContainer-YiFA7E h-full overflow-hidden',
          isScreenMode ? 'sw-simple-viewer-mode' : '',
        )}
        style={STORYBOARD_NODE_SURFACE_STYLE}
      >
        <div
          className="scriptList-cKTA06 storyboard-scrip-list h-full"
          style={STORYBOARD_NODE_SURFACE_STYLE}
        >
          <div className="shotListWrapper-QlYQtE h-full" style={STORYBOARD_NODE_SURFACE_STYLE}>
            <div
              className="shotListContainer-Hu8RJp h-full overflow-hidden"
              style={STORYBOARD_NODE_SURFACE_STYLE}
            >
              <div
                style={{
                  ...STORYBOARD_NODE_SURFACE_STYLE,
                  minHeight: '100%',
                  position: 'relative',
                }}
              >
                <div
                  className={cn(
                    'shotList-GyoD88 thin-scrollbar nowheel h-[1248px] overflow-y-auto overscroll-contain',
                    isScreenMode
                      ? 'flex flex-col items-center gap-[37px] px-[32px] pt-[43px] pb-[48px]'
                      : 'py-[21px]',
                  )}
                  style={STORYBOARD_NODE_SURFACE_STYLE}
                >
                  {renderableShots.map((shot, shotIndex) => (
                    <StoryboardWorkbenchShotItem
                      isSelected={shot.id === selectedShotId}
                      isScreenMode={isScreenMode}
                      key={shot.id}
                      nodeAspectRatio={aspectRatio}
                      nodeId={nodeId}
                      onRedoShot={onRedoShot}
                      onSelectShot={onSelectShot}
                      onUploadShotMedia={onUploadShotMedia}
                      shot={shot}
                      shotIndex={shotIndex}
                    />
                  ))}
                  <StoryboardShotDivider
                    isScreenMode={isScreenMode}
                    nodeId={nodeId}
                    onAddShot={onAddShot}
                    shotId={lastShot.id}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div
        className="listGradient-loAk6h pointer-events-none h-[107px]"
        style={STORYBOARD_NODE_SURFACE_STYLE}
      />
    </div>
  )
}
