import { useMemo } from 'react'
import ProjectChatComposer from '@/features/chat/components/composer/ProjectComposer'
import ProjectConversationPanel from '@/features/chat/components/sidebar/ProjectConversationPanel'
import { useProjectComposerStore } from '@/features/chat/state/project-composer-store'
import { useComposerFileDropZone } from '@/shared/composer/useComposerFileDropZone'
import { useComposerFileIngress } from '@/shared/composer/useComposerFileIngress'
import { cn } from '@/shared/lib/utils'
import { useProjectChatComposer } from '../state/ProjectChatProvider'

interface ProjectSidebarProps {
  className?: string
  floating?: boolean
  panelWidth?: number
}

/**
 * 渲染项目聊天侧栏，包含 assistant-ui 消息投影出的完整对话历史。
 *
 * @param props - 项目聊天侧栏属性。
 * @param props.className - 追加到侧栏根节点的样式类。
 * @param props.floating - 是否以浮动面板模式展示。
 * @param props.panelWidth - 浮动展开态的面板宽度。
 * @returns 项目聊天侧栏元素。
 */
export default function ProjectSidebar({
  className,
  floating = false,
  panelWidth,
}: ProjectSidebarProps) {
  const addAttachments = useProjectComposerStore((s) => s.addAttachments)
  const adjustPendingUploadCount = useProjectComposerStore((s) => s.adjustPendingUploadCount)
  const clearAttachmentErrorMessage = useProjectComposerStore((s) => s.clearAttachmentErrorMessage)
  const attachments = useProjectComposerStore((s) => s.attachments)
  const setAttachmentErrorMessage = useProjectComposerStore((s) => s.setAttachmentErrorMessage)
  const { isInteractionLocked, projectMedia } = useProjectChatComposer()
  const mediaNameSeeds = useMemo(
    () => projectMedia.map((item) => ({ kind: item.kind, name: item.key })),
    [projectMedia],
  )
  const handleFilesSelected = useComposerFileIngress({
    addFiles: addAttachments,
    adjustPendingUploadCount,
    clearAttachmentErrorMessage,
    files: attachments,
    mediaNameSeeds,
    setAttachmentErrorMessage,
  })
  const dropZoneProps = useComposerFileDropZone({
    disabled: isInteractionLocked,
    onFilesSelected: handleFilesSelected,
  })
  const panelClassName = className ? ` ${className}` : ''

  return (
    <div
      className={cn(
        'layer-sidebar relative flex h-full min-h-0 flex-col',
        floating ? '' : 'max-h-full w-full',
        panelClassName,
      )}
      style={
        floating
          ? {
              height: '100%',
              maxHeight: '100%',
              width: typeof panelWidth === 'number' ? `${panelWidth}px` : undefined,
            }
          : undefined
      }
    >
      <section
        className={cn(
          'project-chat-panel-surface relative flex h-full min-h-0 flex-col overflow-hidden border border-chat-panel-border bg-chat-panel-bg shadow-[var(--shadow-chat-panel)]',
          floating ? 'rounded-none rounded-tr-lg' : 'rounded-lg',
        )}
        data-project-chat-drop-zone="true"
        onDragEnter={dropZoneProps.onDragEnter}
        onDragLeave={dropZoneProps.onDragLeave}
        onDragOver={dropZoneProps.onDragOver}
        onDrop={dropZoneProps.onDrop}
        onDropCapture={dropZoneProps.onDropCapture}
        aria-label="项目对话区"
      >
        {dropZoneProps.isDragActive ? (
          <div
            className="layer-local-3 pointer-events-none absolute inset-0 flex items-center justify-center border border-dashed border-on-background bg-[color-mix(in_srgb,var(--color-scrim)_18%,transparent)] p-4 backdrop-blur-[2px]"
            aria-hidden="true"
          >
            <span className="rounded-full border border-border bg-[color:color-mix(in_srgb,var(--color-surface-container-lowest)_90%,transparent)] px-4 py-2 text-body font-medium text-on-background shadow-[var(--shadow-2)]">
              拖拽图片、视频或音频到这里
            </span>
          </div>
        ) : null}
        <ProjectConversationPanel />
        {floating && (
          <div className="project-chat-panel-surface shrink-0 border-t border-chat-panel-border bg-chat-panel-bg">
            <ProjectChatComposer embedded />
          </div>
        )}
      </section>
    </div>
  )
}
