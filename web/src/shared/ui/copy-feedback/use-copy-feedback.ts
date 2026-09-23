/** 复制按钮的「已复制」回显：写剪贴板、短暂切到已复制状态，失败弹错误 toast；按钮长相由调用方决定。 */

import { useCallback, useEffect, useState } from 'react'
import { copyText } from '@/shared/lib/clipboard'
import { toast } from '@/shared/ui/toast'

const COPY_FEEDBACK_MS = 1400

/** `copy(text)` 成功后 `copied` 保持一段时间再复位；每次成功都从头计时，卸载时计时随之清掉。 */
export function useCopyFeedback(): { copied: boolean; copy: (text: string) => Promise<void> } {
  // 每次成功复制加一，0 表示不在回显；计时挂在它上面，连点会取消上一次计时。
  const [copies, setCopies] = useState(0)

  useEffect(() => {
    if (copies === 0) return
    const timer = setTimeout(() => setCopies(0), COPY_FEEDBACK_MS)
    return () => clearTimeout(timer)
  }, [copies])

  const copy = useCallback(async (text: string) => {
    try {
      await copyText(text)
    } catch {
      toast.error('复制失败')
      return
    }
    setCopies((count) => count + 1)
  }, [])

  return { copied: copies !== 0, copy }
}
