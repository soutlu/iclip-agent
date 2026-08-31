/**
 * 会话页的输入框。发送、清空、失败把字还回来，都在这里；气泡由页面那一层管。
 */

import { useState } from 'react'
import { IconButton } from '@/shared/ui/button'
import { Composer } from '@/shared/ui/composer'
import { toast } from '@/shared/ui/toast'

type ConversationComposerProps = {
  /** 发一条。抛异常表示没送到，这里会把字还回输入框。 */
  onSend: (text: string) => Promise<void>
}

/**
 * 渲染会话页输入框。
 *
 * @param props - 组件属性。
 * @param props.onSend - 发送一条消息。
 * @returns 输入框。
 */
export function ConversationComposer({ onSend }: ConversationComposerProps) {
  const [value, setValue] = useState('')
  const [sending, setSending] = useState(false)

  const send = async () => {
    const text = value.trim()
    if (!text) return
    setValue('')
    setSending(true)
    try {
      await onSend(text)
    } catch (error) {
      // 没送到就把字还给输入框，用户接着改或者再发一次。
      setValue(text)
      toast.error(error instanceof Error ? error.message : '发送失败')
    } finally {
      setSending(false)
    }
  }

  return (
    <Composer
      leading={<IconButton label="添加" name="add" size="md" />}
      onSubmit={() => void send()}
      onValueChange={setValue}
      placeholder="接着说…"
      sending={sending}
      value={value}
    />
  )
}
