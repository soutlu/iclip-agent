import type { ComponentPropsWithoutRef, MouseEvent, PointerEvent } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ExtraProps } from 'react-markdown'

type RichMarkdownTableProps = ComponentPropsWithoutRef<'table'> & ExtraProps

const COPY_STATE_DURATION_MS = 1500

/**
 * 阻止表格工具栏按钮触发画布拖拽。
 *
 * @param event - 当前指针事件。
 */
const stopTableActionPropagation = (event: PointerEvent<HTMLButtonElement>) => {
  event.stopPropagation()
}

/**
 * 渲染复制表格图标。
 *
 * @returns 复制表格 SVG 图标。
 */
function CopyTableIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="currentColor"
      height="15"
      viewBox="0 0 256 256"
      width="15"
      xmlns="http://www.w3.org/2000/svg"
    >
      <title>复制表格</title>
      <path d="M216,32H40a8,8,0,0,0-8,8V216a8,8,0,0,0,8,8H216a8,8,0,0,0,8-8V40A8,8,0,0,0,216,32ZM96,208H48V152H96Zm0-72H48V96H96Zm0-56H48V48H96Zm56,128H112V152h40Zm0-72H112V96h40Zm0-56H112V48h40Zm56,128H168V152h40Zm0-72H168V96h40Zm0-56H168V48h40Z" />
    </svg>
  )
}

/**
 * 渲染表格复制完成图标。
 *
 * @returns 复制完成 SVG 图标。
 */
function TableCopiedIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="currentColor"
      height="15"
      viewBox="0 0 256 256"
      width="15"
      xmlns="http://www.w3.org/2000/svg"
    >
      <title>表格已复制</title>
      <path d="M229.66,77.66l-128,128a8,8,0,0,1-11.32,0l-56-56a8,8,0,0,1,11.32-11.32L96,188.69,218.34,66.34a8,8,0,0,1,11.32,11.32Z" />
    </svg>
  )
}

/**
 * 渲染 rich markdown 表格包装器和复制工具栏。
 *
 * @param props - ReactMarkdown 传入的 table 属性。
 * @returns 带横向滚动与复制按钮的表格区域。
 */
export default function RichMarkdownTable({
  children,
  node: _node,
  ...tableProps
}: RichMarkdownTableProps) {
  const [copied, setCopied] = useState(false)
  const tableRef = useRef<HTMLTableElement>(null)
  const resetTimerRef = useRef<ReturnType<typeof globalThis.setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (resetTimerRef.current !== null) {
        globalThis.clearTimeout(resetTimerRef.current)
      }
    }
  }, [])

  /**
   * 将当前表格 HTML 复制到剪贴板，并短暂展示成功状态。
   */
  const handleCopyTable = useCallback(async () => {
    const table = tableRef.current
    const tableText = table?.outerHTML || table?.textContent || ''

    try {
      await navigator.clipboard.writeText(tableText)
      setCopied(true)

      if (resetTimerRef.current !== null) {
        globalThis.clearTimeout(resetTimerRef.current)
      }

      resetTimerRef.current = globalThis.setTimeout(() => {
        setCopied(false)
        resetTimerRef.current = null
      }, COPY_STATE_DURATION_MS)
    } catch {
      setCopied(false)
    }
  }, [])

  /**
   * 处理表格复制按钮点击，并截断画布事件冒泡。
   *
   * @param event - 当前按钮点击事件。
   */
  const handleCopyButtonClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation()
      void handleCopyTable()
    },
    [handleCopyTable],
  )

  return (
    <div className="rich-markdown-table-wrapper">
      <div className="rich-markdown-table-toolbar">
        <span className="rich-markdown-table-label">Table</span>
        <button
          aria-label="复制表格"
          className="rich-markdown-copy-button nodrag nopan"
          onClick={handleCopyButtonClick}
          onPointerDown={stopTableActionPropagation}
          title={copied ? '表格已复制' : '复制表格'}
          type="button"
        >
          {copied ? <TableCopiedIcon /> : <CopyTableIcon />}
        </button>
      </div>
      <div className="rich-markdown-table-scroll thin-scrollbar">
        <table {...tableProps} ref={tableRef}>
          {children}
        </table>
      </div>
    </div>
  )
}
