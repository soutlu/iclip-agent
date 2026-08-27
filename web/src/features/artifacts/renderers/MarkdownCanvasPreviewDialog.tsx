import type { PointerEvent } from 'react'
import type { MarkdownArtifactOutput } from '@/features/artifacts/types/markdown.types'
import { RichMarkdownRenderer } from '@/shared/markdown'
import { DialogBody, DialogHeader, DialogRoot, DialogSurface } from '@/shared/ui/dialog'

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
    <DialogRoot
      modal={false}
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          onClose()
        }
      }}
    >
      <DialogSurface
        aria-label={`${markdown.title} Markdown 预览`}
        aria-modal="true"
        className="markdown-canvas-preview-dialog nodrag nopan nowheel"
        overlayClassName="nodrag nopan nowheel"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onPointerDown={stopDialogPointerPropagation}
      >
        <DialogHeader closeLabel="关闭 Markdown 预览" title={markdown.title} />
        <DialogBody className="overscroll-contain p-0">
          <RichMarkdownRenderer
            identity={`${identity}-expanded`}
            markdown={markdown.markdown}
            variant="expanded-preview"
          />
        </DialogBody>
      </DialogSurface>
    </DialogRoot>
  )
}
