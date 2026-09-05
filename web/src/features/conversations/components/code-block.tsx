import { isValidElement, useState, type ReactNode } from 'react'
import { IconButton } from '@/shared/ui/button'
import { toast } from '@/shared/ui/toast'

const textOf = (node: ReactNode): string => {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children)
  return ''
}

const readCode = (node: ReactNode): { language: string | undefined; text: string } => {
  if (!isValidElement<{ className?: string; children?: ReactNode }>(node)) {
    return { language: undefined, text: '' }
  }
  const language = /language-(\w+)/.exec(node.props.className ?? '')?.[1]
  return { language, text: textOf(node.props.children) }
}

export function CodeBlock({ children }: { children?: ReactNode }) {
  const { language, text } = readCode(children)
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      toast.error('复制失败')
    }
  }

  return (
    <div className="overflow-hidden rounded-sm border-[0.5px] border-chat-hairline bg-chat-code-block-bg shadow-[var(--shadow-xs)]">
      <div className="flex items-center justify-between border-b-[0.5px] border-chat-hairline bg-chat-chip-bg py-1 pr-1 pl-3">
        <span className="text-body-sm text-chat-muted-text">{language ?? 'text'}</span>
        <IconButton
          label="复制代码"
          name={copied ? 'check' : 'copy'}
          onClick={() => void copy()}
          size="xs"
        />
      </div>
      {/* 直接渲染纯文本，不复用 Markdown 的 code 组件，避免块内文字套上行内代码底色。 */}
      <pre className="max-h-[500px] overflow-auto px-3.5 py-3 font-mono text-body-sm whitespace-pre text-chat-message-text">
        {text}
      </pre>
    </div>
  )
}
