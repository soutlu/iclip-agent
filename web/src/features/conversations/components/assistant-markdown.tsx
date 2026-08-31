/**
 * 助手正文按 markdown 渲染：镜头表、代码块、列表这些从模型出来本来就是 markdown。
 *
 * **正文里夹的 HTML 会渲染，但先过白名单**：解析 HTML 与随后过滤这一对，是 react-markdown 自己
 * 在 Security 一节里给的做法（渲染原始 HTML 之后用 rehype-sanitize 收口，过滤必须排在最后一个
 * 不安全步骤之后）。正文是模型写出来的，而模型看得到工具结果、用户输入与外部素材——直接放行
 * 等于把一条 XSS 通道交给它。`script`、`iframe`、`on*` 事件属性、`javascript:` 协议一律被摘掉；
 * 要多放什么标签就往 `SANITIZE` 那张表里加。
 *
 * 元素到 token 的映射写死在下面那张组件表里：行内代码、代码块、表格、链接各用哪个颜色见
 * design-system.html 的 05 · CHAT。
 */

import Markdown from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'
import { cn } from '@/shared/lib/utils'

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
  'rounded-xs border border-chat-code-border bg-chat-code-bg px-1 py-0.5',
  'font-mono text-body-sm text-chat-message-text',
)

const CODE_BLOCK = cn(
  'my-2 max-h-96 overflow-auto rounded-sm bg-chat-code-block-bg px-3 py-2',
  'font-mono text-body-sm whitespace-pre text-chat-message-text',
)

const CELL = 'border border-chat-code-border px-2 py-1 text-left align-top'

/**
 * 渲染一段助手正文。
 *
 * @param props - 组件属性。
 * @param props.text - markdown 正文。
 * @returns 渲染后的正文。
 */
export function AssistantMarkdown({ text }: { text: string }) {
  return (
    <div className="text-body leading-relaxed font-medium text-chat-message-text">
      <Markdown
        components={{
          a: ({ children, href }) => (
            <a
              className="text-chat-link-text underline decoration-chat-link-border underline-offset-2"
              href={href}
              rel="noreferrer noopener"
              target="_blank"
            >
              {children}
            </a>
          ),
          blockquote: ({ children }) => (
            <blockquote className="my-2 border-l-2 border-chat-code-border pl-3 text-chat-secondary-text">
              {children}
            </blockquote>
          ),
          code: ({ children, className }) =>
            // 代码块由 pre 兜着，行内代码没有；两者用同一个组件回调，看有没有语言类名区分不了，
            // 所以按「在不在 pre 里」由 pre 自己套壳，这里只管行内那一份。
            className === undefined ? (
              <code className={CODE_INLINE}>{children}</code>
            ) : (
              <code className="font-mono">{children}</code>
            ),
          em: ({ children }) => <em className="italic">{children}</em>,
          // 正文里的标题最多到 title：会话页的 h1 是对话名，正文不跟它抢层级
          h1: ({ children }) => <h3 className="pt-2 text-title font-semibold">{children}</h3>,
          h2: ({ children }) => <h4 className="pt-2 text-title font-semibold">{children}</h4>,
          h3: ({ children }) => <h5 className="pt-2 text-body font-semibold">{children}</h5>,
          hr: () => <hr className="my-3 border-chat-code-border" />,
          li: ({ children }) => <li className="my-0.5">{children}</li>,
          ol: ({ children }) => <ol className="my-2 list-decimal pl-5">{children}</ol>,
          p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
          pre: ({ children }) => <pre className={CODE_BLOCK}>{children}</pre>,
          strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
          table: ({ children }) => (
            <div className="my-2 overflow-x-auto">
              <table className="w-full border-collapse text-body-sm">{children}</table>
            </div>
          ),
          td: ({ children }) => <td className={CELL}>{children}</td>,
          th: ({ children }) => (
            <th className={cn(CELL, 'bg-chat-chip-bg font-semibold')}>{children}</th>
          ),
          ul: ({ children }) => <ul className="my-2 list-disc pl-5">{children}</ul>,
        }}
        rehypePlugins={[rehypeRaw, [rehypeSanitize, SANITIZE]]}
        remarkPlugins={[remarkGfm]}
      >
        {text}
      </Markdown>
    </div>
  )
}
