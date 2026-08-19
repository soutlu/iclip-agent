import type { ComponentPropsWithoutRef, MouseEvent } from 'react'
import type { ExtraProps } from 'react-markdown'

type RichMarkdownLinkProps = ComponentPropsWithoutRef<'a'> & ExtraProps

/**
 * 判断链接是否为当前 Markdown 内部锚点。
 *
 * @param href - 链接地址。
 * @returns 以 # 开头时返回 true。
 */
const isInternalAnchor = (href: string | undefined): boolean => {
  return href?.startsWith('#') ?? false
}

/**
 * 阻止链接点击参与画布拖拽事件冒泡。
 *
 * @param event - 当前链接点击事件。
 */
const stopLinkPropagation = (event: MouseEvent<HTMLAnchorElement>) => {
  event.stopPropagation()
}

/**
 * 渲染 rich markdown 链接。
 *
 * @param props - ReactMarkdown 传入的链接属性。
 * @returns 支持外链新窗口和内部锚点的链接元素。
 */
export default function RichMarkdownLink({
  children,
  href,
  node: _node,
  ...anchorProps
}: RichMarkdownLinkProps) {
  const externalLinkProps =
    href !== undefined && !isInternalAnchor(href)
      ? { rel: 'noreferrer noopener', target: '_blank' }
      : {}

  return (
    <a {...anchorProps} {...externalLinkProps} href={href} onClick={stopLinkPropagation}>
      {children}
    </a>
  )
}
