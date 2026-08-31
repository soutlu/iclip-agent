/**
 * 助手正文按 markdown 渲染：镜头表、代码块、列表这些从模型出来本来就是 markdown。
 *
 * **正文里夹的 HTML 会渲染，但先过白名单**：解析 HTML 与随后过滤这一对，是 react-markdown 自己
 * 在 Security 一节里给的做法（渲染原始 HTML 之后用 rehype-sanitize 收口，过滤必须排在最后一个
 * 不安全步骤之后）。正文是模型写出来的，而模型看得到工具结果、用户输入与外部素材——直接放行
 * 等于把一条 XSS 通道交给它。`script`、`iframe`、`on*` 事件属性、`javascript:` 协议一律被摘掉；
 * 要多放什么标签就往 `SANITIZE` 那张表里加。
 *
 * 排版照 kimi 网页版：正文 400 字重、行高约 1.625；顶层块间距、列表圆点、引用竖条这些细节
 * 在 ../conversations.css 的 .chat-md 里；行内代码、标题、链接、表格的 token 映射在下面那张
 * 组件表里（见 design-system.html 的 05 · CHAT）。
 */

import Markdown from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'
import { cn } from '@/shared/lib/utils'
import { CodeBlock } from './code-block'

/**
 * 允许出现在正文里的 HTML。
 *
 * 底子是 rehype-sanitize 自带的那份（GitHub 的白名单：段落、列表、表格、`details`、`img` 等），
 * 这里再加视频与它的尺寸/播放属性——产品本身就是做视频的，正文里贴一段预览是常事。
 */
const SANITIZE = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    img: [...(defaultSchema.attributes?.['img'] ?? []), 'alt', 'title', 'width', 'height'],
    source: [...(defaultSchema.attributes?.['source'] ?? []), 'src', 'type'],
    video: ['src', 'poster', 'controls', 'loop', 'muted', 'playsInline', 'width', 'height'],
  },
  tagNames: [...(defaultSchema.tagNames ?? []), 'video', 'figure', 'figcaption'],
}

const CODE_INLINE = cn(
  'rounded-xs bg-chat-code-bg px-1.5 py-0.5',
  'font-mono text-body-sm text-chat-link-text',
)

const CELL = 'border-[0.5px] border-chat-hairline px-3 py-2 text-left align-top'

/**
 * 渲染一段助手正文。
 *
 * @param props - 组件属性。
 * @param props.text - markdown 正文。
 * @returns 渲染后的正文。
 */
export function AssistantMarkdown({ text }: { text: string }) {
  return (
    <div className="chat-md text-body leading-relaxed text-chat-message-text">
      <Markdown
        components={{
          a: ({ children, href }) => (
            <a
              className="text-chat-link-text no-underline decoration-chat-link-border underline-offset-2 hover:underline"
              href={href}
              rel="noreferrer noopener"
              target="_blank"
            >
              {children}
            </a>
          ),
          code: ({ children, className }) =>
            // 代码块由 pre 兜着（CodeBlock），这里只管行内那一份。语言类名留在 code 上，
            // CodeBlock 要从它读出语言名。
            className === undefined ? (
              <code className={CODE_INLINE}>{children}</code>
            ) : (
              <code className={cn('font-mono', className)}>{children}</code>
            ),
          em: ({ children }) => <em className="italic">{children}</em>,
          // 正文里的标题最多到 title：会话页的 h1 是对话名，正文不跟它抢层级。
          // h1 底部多一条发丝线（照 kimi markdown 的 h1）；块间距由 .chat-md 统一给
          h1: ({ children }) => (
            <h3 className="border-b-[0.5px] border-chat-hairline pb-1 text-title font-semibold">
              {children}
            </h3>
          ),
          h2: ({ children }) => <h4 className="text-title font-semibold">{children}</h4>,
          h3: ({ children }) => <h5 className="text-body font-semibold">{children}</h5>,
          hr: () => <hr className="border-chat-hairline" />,
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
          table: ({ children }) => (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-body-sm">{children}</table>
            </div>
          ),
          td: ({ children }) => <td className={CELL}>{children}</td>,
          th: ({ children }) => (
            <th className={cn(CELL, 'bg-chat-chip-bg font-semibold')}>{children}</th>
          ),
        }}
        rehypePlugins={[rehypeRaw, [rehypeSanitize, SANITIZE]]}
        remarkPlugins={[remarkGfm]}
      >
        {text}
      </Markdown>
    </div>
  )
}
