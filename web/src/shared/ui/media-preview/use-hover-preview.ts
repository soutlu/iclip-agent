/** 参考 Kimi mention-tip：首次显示延迟 150ms，关闭延迟 120ms，关闭后 400ms 内切换免延迟；锚点与卡共用回调。 */

import { useCallback, useEffect, useRef, useState } from 'react'

const OPEN_DELAY_MS = 150
const CLOSE_DELAY_MS = 120
const WARM_REOPEN_MS = 400

/** 跨卡片共享最近关闭时间，用于连续悬停时免延迟。 */
let lastClosedAt = 0

/** 返回稳定的悬停回调，可直接绑定 DOM 监听器。 */
export const useHoverPreview = () => {
  const [open, setOpen] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current)
    timerRef.current = null
  }, [])
  useEffect(() => clearTimer, [clearTimer])

  const close = useCallback(() => {
    clearTimer()
    lastClosedAt = Date.now()
    setOpen(false)
  }, [clearTimer])

  const onEnter = useCallback(() => {
    clearTimer()
    const cold = Date.now() - lastClosedAt >= WARM_REOPEN_MS
    timerRef.current = setTimeout(() => setOpen(true), cold ? OPEN_DELAY_MS : 0)
  }, [clearTimer])

  const onLeave = useCallback(() => {
    clearTimer()
    timerRef.current = setTimeout(close, CLOSE_DELAY_MS)
  }, [clearTimer, close])

  return { close, onEnter, onLeave, open }
}
