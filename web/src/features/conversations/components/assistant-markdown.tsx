/** 模型正文可能包含不可信 HTML。按 react-markdown Security 建议，在 rehype-raw 后执行 rehype-sanitize，过滤脚本、事件属性及危险协议。 */

import Markdown from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'
import { cn } from '@/shared/lib/utils'
import { CodeBlock } from './code-block'

/** 在 rehype-sanitize 默认白名单上增加视频及尺寸、播放属性。 */
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
  'font-mono text-body-sm text-chat-message-text',
)

const CELL = 'border-[0.5px] border-chat-hairline px-3 py-2 text-left align-top'

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
          // 代码块由 pre → CodeBlock 读取语言与文本自行渲染，这里只会渲染到行内代码。
          code: ({ children }) => <code className={CODE_INLINE}>{children}</code>,
          em: ({ children }) => <em className="italic">{children}</em>,
          // 正文标题使用 title 字阶；会话名保留页面标题层级，块间距由 .chat-md 统一定义。
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
