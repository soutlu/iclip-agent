import type { ComponentPropsWithoutRef, ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ExtraProps } from 'react-markdown'
import { cn } from '@/shared/lib/utils'
import { RICH_MARKDOWN_BASE_CSS } from '@/shared/markdown/rich-markdown.constants'
import type { RichMarkdownRendererVariant } from '@/shared/markdown/rich-markdown.types'

interface RichMarkdownStyleScopeProps {
  children: ReactNode
  className: string
  identity: string
  variant: RichMarkdownRendererVariant
}

type RichMarkdownStyleElementProps = ComponentPropsWithoutRef<'style'> & ExtraProps

/**
 * 在 ShadowRoot 中安装 Producer rich markdown 基础样式。
 *
 * @param shadowRoot - 当前 Markdown 渲染实例的 ShadowRoot。
 */
const installRichMarkdownShadowStyles = (shadowRoot: ShadowRoot) => {
  const existingStyle = shadowRoot.querySelector('style[data-rich-markdown-base-style="true"]')

  if (existingStyle !== null) {
    existingStyle.textContent = RICH_MARKDOWN_BASE_CSS
    return
  }

  const style = document.createElement('style')
  style.dataset.richMarkdownBaseStyle = 'true'
  style.textContent = RICH_MARKDOWN_BASE_CSS
  shadowRoot.prepend(style)
}

/**
 * 渲染 Markdown 原始 style 标签。
 *
 * @param props - ReactMarkdown 传入的 style 标签属性。
 * @returns 保留 children 的 style 元素。
 */
export function RichMarkdownStyleElement({
  children,
  node: _node,
  ...styleProps
}: RichMarkdownStyleElementProps) {
  return <style {...styleProps}>{children}</style>
}

/**
 * 将整棵 rich markdown 内容渲染到 Shadow DOM 中，隔离模型输出 style。
 *
 * @param props - Shadow DOM 渲染属性。
 * @param props.children - 已构建的 Markdown React 内容。
 * @param props.className - 根节点 className。
 * @param props.identity - 当前 Markdown 实例 identity。
 * @param props.variant - 当前 Markdown 展示形态。
 * @returns 承载 ShadowRoot 的 host 元素。
 */
export default function RichMarkdownStyleScope({
  children,
  className,
  identity,
  variant,
}: RichMarkdownStyleScopeProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [shadowRoot, setShadowRoot] = useState<ShadowRoot | null>(null)

  useEffect(() => {
    const host = hostRef.current

    if (host === null) {
      return
    }

    const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' })
    installRichMarkdownShadowStyles(root)
    setShadowRoot(root)
  }, [])

  return (
    <div
      className={cn(className, 'rich-markdown-shadow-host')}
      data-rich-markdown-identity={identity}
      data-rich-markdown-variant={variant}
      ref={hostRef}
    >
      {shadowRoot === null
        ? null
        : createPortal(
            <div
              className={className}
              data-rich-markdown-identity={identity}
              data-rich-markdown-shadow-content="true"
              data-rich-markdown-variant={variant}
            >
              {children}
            </div>,
            shadowRoot,
          )}
    </div>
  )
}
