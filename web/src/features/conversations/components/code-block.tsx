/**
 * 代码块：头部条（语言名 + 复制钮）+ 体，照 kimi 网页版的 code-block-container——
 * 0.5px 发丝边框、radius sm、shadow-xs，体最高 500px 可滚动。
 */

import { isValidElement, useState, type ReactNode } from 'react'
import { IconButton } from '@/shared/ui/button'
import { toast } from '@/shared/ui/toast'

/** 递归摊平 react-markdown 的 children，拿到代码原文（复制用）。 */
const textOf = (node: ReactNode): string => {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children)
  return ''
}

/** 从 react-markdown 映射后的 code 元素上读语言类名与原文。 */
const readCode = (node: ReactNode): { language: string | undefined; text: string } => {
  if (!isValidElement<{ className?: string; children?: ReactNode }>(node)) {
    return { language: undefined, text: '' }
  }
  const language = /language-(\w+)/.exec(node.props.className ?? '')?.[1]
  return { language, text: textOf(node.props.children) }
}

/**
 * 渲染一个代码块。children 是 react-markdown 映射后的 code 元素，原样放进 pre 里渲染；
 * 语言与原文另从它的 props 上读出来给头部条。
 *
 * @param props - 组件属性。
 * @param props.children - code 元素。
 * @returns 带头部条的代码块。
 */
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
      <pre className="max-h-[500px] overflow-auto px-3.5 py-3 font-mono text-body-sm whitespace-pre text-chat-message-text">
        {children}
      </pre>
    </div>
  )
}
