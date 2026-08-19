import type { ComponentPropsWithoutRef, MouseEvent, PointerEvent, ReactNode } from 'react'
import { Children, isValidElement, useCallback, useEffect, useRef, useState } from 'react'
import type { ExtraProps } from 'react-markdown'

export type RichMarkdownCodeBlockProps = ComponentPropsWithoutRef<'code'> &
  ExtraProps & {
    inline?: boolean
  }

const COPY_STATE_DURATION_MS = 1500
const LANGUAGE_CLASS_PATTERN = /(?:^|\s)language-([^\s]+)/

/**
 * 阻止代码块按钮触发画布拖拽。
 *
 * @param event - 当前指针事件。
 */
const stopCodeActionPropagation = (event: PointerEvent<HTMLButtonElement>) => {
  event.stopPropagation()
}

/**
 * 从 code className 中提取语言标签。
 *
 * @param className - ReactMarkdown 传入的 code className。
 * @returns 代码语言；缺省时返回 text。
 */
const resolveCodeLanguage = (className: string | undefined): string => {
  const language = className?.match(LANGUAGE_CLASS_PATTERN)?.[1]

  return language ?? 'text'
}

/**
 * 将 React children 提取为可复制的纯文本。
 *
 * @param children - code 节点的 React 子内容。
 * @returns 拼接后的纯文本。
 */
export const extractMarkdownText = (children: ReactNode): string => {
  if (typeof children === 'string' || typeof children === 'number') {
    return String(children)
  }

  if (children === null || children === undefined || typeof children === 'boolean') {
    return ''
  }

  if (Array.isArray(children)) {
    return (children as ReactNode[]).map((child) => extractMarkdownText(child)).join('')
  }

  if (isValidElement<{ children?: ReactNode }>(children)) {
    return extractMarkdownText(children.props.children)
  }

  return Children.toArray(children)
    .map((child) => extractMarkdownText(child))
    .join('')
}

/**
 * 渲染复制代码图标。
 *
 * @returns 复制代码 SVG 图标。
 */
function CopyCodeIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="currentColor"
      height="15"
      viewBox="0 0 256 256"
      width="15"
      xmlns="http://www.w3.org/2000/svg"
    >
      <title>复制代码</title>
      <path d="M216,32H88a8,8,0,0,0-8,8V80H40a8,8,0,0,0-8,8V216a8,8,0,0,0,8,8H168a8,8,0,0,0,8-8V176h40a8,8,0,0,0,8-8V40A8,8,0,0,0,216,32ZM160,208H48V96H160Zm48-48H176V88a8,8,0,0,0-8-8H96V48H208Z" />
    </svg>
  )
}

/**
 * 渲染代码复制完成图标。
 *
 * @returns 复制完成 SVG 图标。
 */
function CodeCopiedIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="currentColor"
      height="15"
      viewBox="0 0 256 256"
      width="15"
      xmlns="http://www.w3.org/2000/svg"
    >
      <title>代码已复制</title>
      <path d="M229.66,77.66l-128,128a8,8,0,0,1-11.32,0l-56-56a8,8,0,0,1,11.32-11.32L96,188.69,218.34,66.34a8,8,0,0,1,11.32,11.32Z" />
    </svg>
  )
}

/**
 * 渲染 rich markdown 行内或块级代码。
 *
 * @param props - ReactMarkdown 传入的 code 属性。
 * @returns 行内 code 或带工具栏的代码块。
 */
export default function RichMarkdownCodeBlock({
  children,
  className,
  inline = true,
  node: _node,
  ...codeProps
}: RichMarkdownCodeBlockProps) {
  const [copied, setCopied] = useState(false)
  const resetTimerRef = useRef<ReturnType<typeof globalThis.setTimeout> | null>(null)
  const codeText = extractMarkdownText(children)
  const language = resolveCodeLanguage(className)

  useEffect(() => {
    return () => {
      if (resetTimerRef.current !== null) {
        globalThis.clearTimeout(resetTimerRef.current)
      }
    }
  }, [])

  /**
   * 将当前代码块内容复制到剪贴板，并短暂展示成功状态。
   */
  const handleCopyCode = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(codeText)
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
  }, [codeText])

  /**
   * 处理代码复制按钮点击，并让异步复制在事件外完成。
   *
   * @param event - 当前按钮点击事件。
   */
  const handleCopyButtonClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation()
      void handleCopyCode()
    },
    [handleCopyCode],
  )

  if (inline) {
    return (
      <code {...codeProps} className={className}>
        {children}
      </code>
    )
  }

  return (
    <figure className="rich-markdown-code-block">
      <figcaption className="rich-markdown-code-toolbar">
        <span className="rich-markdown-code-language">{language}</span>
        <button
          aria-label="复制代码"
          className="rich-markdown-copy-button nodrag nopan"
          onClick={handleCopyButtonClick}
          onPointerDown={stopCodeActionPropagation}
          title={copied ? '代码已复制' : '复制代码'}
          type="button"
        >
          {copied ? <CodeCopiedIcon /> : <CopyCodeIcon />}
        </button>
      </figcaption>
      <div className="rich-markdown-code-scroll thin-scrollbar">
        <pre>
          <code {...codeProps} className={className}>
            {children}
          </code>
        </pre>
      </div>
    </figure>
  )
}
