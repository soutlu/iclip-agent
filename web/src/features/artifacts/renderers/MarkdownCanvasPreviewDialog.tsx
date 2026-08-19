import { Dialog } from 'radix-ui'
import type { PointerEvent } from 'react'
import type { MarkdownArtifactOutput } from '@/features/artifacts/types/markdown.types'
import { RichMarkdownRenderer } from '@/shared/markdown'

export interface MarkdownCanvasPreviewDialogProps {
  identity: string
  markdown: MarkdownArtifactOutput
  onClose: () => void
}

/**
 * 阻止弹层内部指针事件触发画布拖拽。
 *
 * @param event - 当前指针事件。
 */
const stopDialogPointerPropagation = (event: PointerEvent<HTMLElement>) => {
  event.stopPropagation()
}

/**
 * 渲染关闭 Markdown 预览图标。
 *
 * @returns 关闭 SVG 图标。
 */
function CloseMarkdownPreviewIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="18"
      viewBox="0 0 24 24"
      width="18"
      xmlns="http://www.w3.org/2000/svg"
    >
      <title>关闭 Markdown 预览</title>
      <line
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="2.4"
        x1="18"
        x2="6"
        y1="6"
        y2="18"
      />
      <line
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="2.4"
        x1="6"
        x2="18"
        y1="6"
        y2="18"
      />
    </svg>
  )
}

/**
 * 渲染画布 Markdown 展开预览弹层。
 *
 * 基于 Radix Dialog（非 modal，与原手写版一致：不锁焦点、不锁滚动），
 * Escape 与外部点击关闭由 Radix 处理。
 *
 * @param props - Markdown 预览弹层属性。
 * @param props.identity - 当前 Markdown 卡片的稳定 identity。
 * @param props.markdown - Markdown 标题和正文。
 * @param props.onClose - 关闭弹层回调。
 * @returns Portal 到 document.body 的 Markdown 阅读弹层。
 */
export default function MarkdownCanvasPreviewDialog({
  identity,
  markdown,
  onClose,
}: MarkdownCanvasPreviewDialogProps) {
  return (
    <Dialog.Root
      modal={false}
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          onClose()
        }
      }}
    >
      <Dialog.Portal>
        <div className="markdown-canvas-preview-overlay nodrag nopan nowheel layer-popup fixed inset-0 flex items-center justify-center">
          <div className="markdown-canvas-preview-backdrop absolute inset-0" />
          <Dialog.Content
            aria-label={`${markdown.title} Markdown 预览`}
            aria-modal="true"
            className="markdown-canvas-preview-dialog nodrag nopan nowheel layer-local-1 relative flex flex-col overflow-hidden"
            onOpenAutoFocus={(event) => event.preventDefault()}
            onPointerDown={stopDialogPointerPropagation}
          >
            <header className="markdown-canvas-preview-dialog-header flex shrink-0 items-center justify-between gap-4">
              <Dialog.Title asChild>
                <h2>{markdown.title}</h2>
              </Dialog.Title>
              <button
                aria-label="关闭 Markdown 预览"
                className="markdown-canvas-icon-button"
                onClick={onClose}
                title="关闭 Markdown 预览"
                type="button"
              >
                <CloseMarkdownPreviewIcon />
              </button>
            </header>
            <div className="markdown-canvas-preview-dialog-body thin-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain">
              <RichMarkdownRenderer
                identity={`${identity}-expanded`}
                markdown={markdown.markdown}
                variant="expanded-preview"
              />
            </div>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
