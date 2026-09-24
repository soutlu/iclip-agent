import { IconButton } from '@/shared/ui/button'
import { useCopyFeedback } from '@/shared/ui/copy-feedback'

export function CopyButton({ label = '复制', text }: { text: string; label?: string }) {
  const { copied, copy } = useCopyFeedback()

  return (
    <IconButton
      className="text-chat-muted-text"
      label={label}
      name={copied ? 'check' : 'copy'}
      onClick={() => void copy(text)}
      size="xs"
      title={copied ? '已复制' : '复制'}
      variant="standard"
    />
  )
}
