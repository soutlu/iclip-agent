/**
 * 悬停卡的出没时序（照 kimi 网页版的 mention-tip 控制器）：冷启动 150ms 才出现、离开 120ms
 * 才关闭；刚关过一张就移到下一颗立即出现（400ms 内算「还在看」）。
 *
 * 光标在锚点与卡片之间往返不该关卡，所以两边挂同一对 `onEnter` / `onLeave` 接力就行。
 */

import { useCallback, useEffect, useRef, useState } from 'react'

const OPEN_DELAY_MS = 150
const CLOSE_DELAY_MS = 120
/** 两张卡之间移动免延迟的窗口。 */
const WARM_REOPEN_MS = 400

/** 全局只有一张悬停卡：最近一张关闭的时刻，用来判游走要不要免延迟。 */
let lastClosedAt = 0

/**
 * 管一张悬停卡的开合时序。
 *
 * @returns 卡在不在，以及锚点与卡片共用的三个回调（身份稳定，可直接挂 DOM 监听器）。
 */
export const useHoverPreview = () => {
  const [open, setOpen] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current)
    timerRef.current = null
  }, [])
  useEffect(() => clearTimer, [clearTimer])

  /** 立刻收起（点了「全屏查看」之类）。 */
  const close = useCallback(() => {
    clearTimer()
    lastClosedAt = Date.now()
    setOpen(false)
  }, [clearTimer])

  /** 光标进了锚点或卡片。 */
  const onEnter = useCallback(() => {
    clearTimer()
    const cold = Date.now() - lastClosedAt >= WARM_REOPEN_MS
    timerRef.current = setTimeout(() => setOpen(true), cold ? OPEN_DELAY_MS : 0)
  }, [clearTimer])

  /** 光标离开了锚点或卡片。 */
  const onLeave = useCallback(() => {
    clearTimer()
    timerRef.current = setTimeout(close, CLOSE_DELAY_MS)
  }, [clearTimer, close])

  return { close, onEnter, onLeave, open }
}
