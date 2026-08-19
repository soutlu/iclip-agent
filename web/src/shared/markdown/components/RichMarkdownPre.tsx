import type { ComponentPropsWithoutRef } from 'react'
import { Children, isValidElement } from 'react'
import type { ExtraProps } from 'react-markdown'
import RichMarkdownCodeBlock, {
  type RichMarkdownCodeBlockProps,
} from '@/shared/markdown/components/RichMarkdownCodeBlock'

type RichMarkdownPreProps = ComponentPropsWithoutRef<'pre'> & ExtraProps

/**
 * 从 pre 子节点中提取单个 code 元素。
 *
 * @param children - ReactMarkdown 传入的 pre 子内容。
 * @returns 单个 code React 元素；无法识别时返回 null。
 */
const getOnlyCodeChild = (children: RichMarkdownPreProps['children']) => {
  const childNodes = Children.toArray(children)

  if (childNodes.length !== 1) {
    return null
  }

  const [onlyChild] = childNodes

  if (!isValidElement<RichMarkdownCodeBlockProps>(onlyChild)) {
    return null
  }

  return onlyChild
}

/**
 * 渲染 rich markdown pre 容器，并把围栏代码委托给代码块组件。
 *
 * @param props - ReactMarkdown 传入的 pre 属性。
 * @returns 代码块工具栏或普通 pre 滚动容器。
 */
export default function RichMarkdownPre({
  children,
  node: _node,
  ...preProps
}: RichMarkdownPreProps) {
  const codeChild = getOnlyCodeChild(children)

  if (codeChild !== null) {
    return <RichMarkdownCodeBlock {...codeChild.props} inline={false} />
  }

  return (
    <pre {...preProps} className="rich-markdown-pre-scroll thin-scrollbar">
      {children}
    </pre>
  )
}
