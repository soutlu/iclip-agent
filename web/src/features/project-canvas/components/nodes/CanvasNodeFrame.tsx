import type { ReactNode } from 'react'
import { cn } from '@/shared/lib/utils'

interface CanvasNodeFrameProps {
  children: ReactNode
  exportRef?: (element: HTMLDivElement | null) => void
  highlightToken: number
  isHighlighted: boolean
  onSelect: () => void
  selected: boolean
  title: string
}

/**
 * 渲染所有画布节点共享的固定外框。
 *
 * @param props - 画布节点外框属性。
 * @param props.children - 节点内部业务卡片内容。
 * @param props.exportRef - 注册导出 DOM 的回调。
 * @param props.highlightToken - 高亮动画批次标记。
 * @param props.isHighlighted - 当前节点是否处于高亮状态。
 * @param props.onSelect - 选中当前节点的回调。
 * @param props.selected - 当前节点是否被选中。
 * @param props.title - 节点浏览器悬浮标题。
 * @returns 带选中、高亮、阴影和固定高度继承的画布节点外框。
 */
export default function CanvasNodeFrame({
  children,
  exportRef,
  highlightToken,
  isHighlighted,
  onSelect,
  selected,
  title,
}: CanvasNodeFrameProps) {
  const borderClassName = selected
    ? 'border-[var(--color-canvas-card-border)]'
    : isHighlighted
      ? 'border-[var(--color-border-hover)]'
      : 'border-transparent'
  return (
    <div
      className={cn(
        'group canvas-node-drag-surface canvas-node-reveal relative h-full w-full text-left',
        'transition-transform duration-[var(--dur-s)] ease-[var(--ease)]',
        selected ? '' : 'hover:scale-[1.005]',
      )}
      onPointerUpCapture={onSelect}
      title={title}
    >
      {selected ? (
        <>
          {/* 选中外环：外扩 6px，圆角随 --radius-2xl 同步补偿以保持与内环同心 */}
          <span
            aria-hidden="true"
            className="pointer-events-none absolute -inset-[6px] rounded-[calc(var(--radius-2xl)+6px)] border-2 border-[var(--color-ring-highlight)]"
          />
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 rounded-2xl border-2 border-[var(--color-canvas-card-border)]"
          />
        </>
      ) : null}

      {isHighlighted ? (
        <span
          key={highlightToken}
          aria-hidden="true"
          className="canvas-highlight-flash pointer-events-none absolute inset-0 rounded-2xl border-2 border-[var(--color-canvas-card-border)]"
        />
      ) : null}

      <div
        ref={exportRef}
        className={cn(
          'flex h-full w-full flex-col overflow-hidden rounded-2xl border bg-[var(--color-canvas-card-bg)] text-[var(--color-canvas-card-text)]',
          'transition-[transform,border-color] duration-[var(--dur-s)] ease-[var(--ease)]',
          borderClassName,
        )}
      >
        <div className="canvas-node-copyable relative h-full min-h-0 w-full">{children}</div>
      </div>
    </div>
  )
}
