/**
 * 「复制」图标钮：写进剪贴板后图标变勾 1.4 秒再复位，失败弹一声。
 * 助手终态栏与用户气泡共用同一颗，外壳都是 24×24 透明图标钮。
 */

import { useState } from 'react'
import { IconButton } from '@/shared/ui/button'
import { toast } from '@/shared/ui/toast'

const COPY_FEEDBACK_MS = 1400

/**
 * 渲染复制钮。
 *
 * @param props - 组件属性。
 * @param props.text - 要写进剪贴板的文字。
 * @param props.label - 读屏用的名字；一轮里用户与助手各有一颗，名字得分得开。
 * @returns 复制钮。
 */
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
