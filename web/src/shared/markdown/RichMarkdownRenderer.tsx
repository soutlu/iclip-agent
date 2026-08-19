import type { ComponentPropsWithoutRef } from 'react'
import { useMemo } from 'react'
import ReactMarkdown, { type Components, type ExtraProps } from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import rehypeRaw from 'rehype-raw'
import remarkCjkFriendly from 'remark-cjk-friendly'
import remarkGfm from 'remark-gfm'
import remarkGithubBlockquoteAlert from 'remark-github-blockquote-alert'
import remarkMath from 'remark-math'
import type { PluggableList } from 'unified'
import { cn } from '@/shared/lib/utils'
import RichMarkdownCodeBlock from '@/shared/markdown/components/RichMarkdownCodeBlock'
import RichMarkdownLink from '@/shared/markdown/components/RichMarkdownLink'
import RichMarkdownPre from '@/shared/markdown/components/RichMarkdownPre'
import RichMarkdownStyleScope, {
  RichMarkdownStyleElement,
} from '@/shared/markdown/components/RichMarkdownStyleScope'
import RichMarkdownSvg from '@/shared/markdown/components/RichMarkdownSvg'
import RichMarkdownTable from '@/shared/markdown/components/RichMarkdownTable'
import { rehypeHeadingIds } from '@/shared/markdown/plugins/rehypeHeadingIds'
import { rehypeSafeAttributeNames } from '@/shared/markdown/plugins/rehypeSafeAttributeNames'
import { rehypeScalableSvg } from '@/shared/markdown/plugins/rehypeScalableSvg'
import { remarkDisableConstructs } from '@/shared/markdown/plugins/remarkDisableConstructs'
import type {
  RichMarkdownRendererProps,
  RichMarkdownRendererVariant,
} from '@/shared/markdown/rich-markdown.types'

type RichMarkdownParagraphProps = ComponentPropsWithoutRef<'p'> & ExtraProps

const BLOCK_MEDIA_TAG_NAMES = new Set(['img', 'svg', 'table'])
const STYLE_TAG_PATTERN = /<style(?:\s|>)/i
const RICH_MARKDOWN_REMARK_PLUGINS: PluggableList = [
  [remarkGfm, { singleTilde: false }],
  remarkGithubBlockquoteAlert,
  remarkCjkFriendly,
  remarkDisableConstructs(['codeIndented']),
  remarkMath,
]

/**
 * 判断 Markdown 原文是否包含 style 标签。
 *
 * @param markdown - 模型输出的 Markdown 原文。
 * @returns 包含 style 标签时返回 true。
 */
const containsStyleTag = (markdown: string): boolean => {
  return STYLE_TAG_PATTERN.test(markdown)
}

/**
 * 判断段落是否直接包含媒体或块级 HTML 节点。
 *
 * @param node - ReactMarkdown 传入的段落 HAST 节点。
 * @returns 需要用 div 替代 p 时返回 true。
 */
const paragraphContainsBlockMedia = (node: RichMarkdownParagraphProps['node']): boolean => {
  return (
    node?.children.some(
      (child) => child.type === 'element' && BLOCK_MEDIA_TAG_NAMES.has(child.tagName),
    ) ?? false
  )
}

/**
 * 为 rich markdown 根节点生成 className。
 *
 * @param variant - 当前 Markdown 展示形态。
 * @param className - 调用方传入的额外 className。
 * @returns 根节点 className。
 */
const createRichMarkdownClassName = (
  variant: RichMarkdownRendererVariant,
  className: string | undefined,
): string => {
  const variantClassName =
    variant === 'expanded-preview' ? 'rich-markdown-expanded-body' : 'rich-markdown-canvas-body'

  return cn('rich-markdown-body', variantClassName, className)
}

/**
 * 让 ReactMarkdown 保留可信模型输出中的原始 URL。
 *
 * @param url - ReactMarkdown 解析出的 URL。
 * @returns 未经过滤的原始 URL。
 */
const preserveTrustedMarkdownUrl = (url: string): string => {
  return url
}

/**
 * 渲染 rich markdown 段落，并避免媒体节点被包在 p 中。
 *
 * @param props - ReactMarkdown 传入的段落属性。
 * @returns p 或 div 元素。
 */
function RichMarkdownParagraph({ children, node, ...paragraphProps }: RichMarkdownParagraphProps) {
  if (paragraphContainsBlockMedia(node)) {
    return <div {...paragraphProps}>{children}</div>
  }

  return <p {...paragraphProps}>{children}</p>
}

const RICH_MARKDOWN_COMPONENTS: Components = {
  a: RichMarkdownLink,
  code: RichMarkdownCodeBlock,
  p: RichMarkdownParagraph,
  pre: RichMarkdownPre,
  style: RichMarkdownStyleElement,
  svg: RichMarkdownSvg,
  table: RichMarkdownTable,
}

/**
 * 根据 identity 创建 rehype 插件链。
 *
 * @param identity - 当前 Markdown 实例的稳定 identity。
 * @returns ReactMarkdown 使用的 rehype 插件列表。
 */
const createRichMarkdownRehypePlugins = (identity: string): PluggableList => {
  return [
    rehypeRaw,
    rehypeSafeAttributeNames,
    rehypeScalableSvg,
    [rehypeHeadingIds, { prefix: identity }],
    rehypeKatex,
  ]
}

/**
 * 渲染 Producer 画布使用的完整 Markdown/GFM/HTML 输出。
 *
 * @param props - Rich markdown renderer 属性。
 * @param props.className - 根节点额外 className。
 * @param props.identity - 标题 id、SVG、表格和测试定位使用的稳定身份。
 * @param props.markdown - 完整模型输出正文。
 * @param props.variant - 当前展示形态；默认为画布预览。
 * @returns 支持 HTML、Alert、CJK、数学公式、SVG、style 隔离和复制工具栏的 Markdown 内容。
 */
export default function RichMarkdownRenderer({
  className,
  identity,
  markdown,
  variant = 'canvas-preview',
}: RichMarkdownRendererProps) {
  const rootClassName = createRichMarkdownClassName(variant, className)
  const rehypePlugins = useMemo(() => createRichMarkdownRehypePlugins(identity), [identity])
  const content = (
    <ReactMarkdown
      components={RICH_MARKDOWN_COMPONENTS}
      rehypePlugins={rehypePlugins}
      remarkPlugins={RICH_MARKDOWN_REMARK_PLUGINS}
      urlTransform={preserveTrustedMarkdownUrl}
    >
      {markdown}
    </ReactMarkdown>
  )

  if (containsStyleTag(markdown)) {
    return (
      <RichMarkdownStyleScope className={rootClassName} identity={identity} variant={variant}>
        {content}
      </RichMarkdownStyleScope>
    )
  }

  return (
    <div
      className={rootClassName}
      data-rich-markdown-identity={identity}
      data-rich-markdown-variant={variant}
    >
      {content}
    </div>
  )
}
