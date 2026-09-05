import { useState } from 'react'
import { IconButton } from '@/shared/ui/button'
import { toast } from '@/shared/ui/toast'

const COPY_FEEDBACK_MS = 1400

export function CopyButton({ label = '复制', text }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), COPY_FEEDBACK_MS)
    } catch {
      toast.error('复制失败')
    }
  }

  return (
    <IconButton
      className="text-chat-muted-text"
      label={label}
      name={copied ? 'check' : 'copy'}
      onClick={() => void copy()}
      size="xs"
      title={copied ? '已复制' : '复制'}
      variant="standard"
    />
  )
}
