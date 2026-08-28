import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * PopupContent 触发器的锚点追踪：维护触发元素 ref、开合状态与锚点 DOMRect，
 * 弹层打开期间跟随窗口 resize / 滚动刷新位置。
 *
 * 打开时调用方先 updateAnchorRect() 再 setOpen(true)——锚点在事件里量，不在 effect 里
 * 补量，否则首帧会先按旧位置画一次。
 *
 * @returns 触发器 ref、锚点矩形、开合状态与手动刷新锚点的方法。
 */
export function usePopupAnchor<T extends HTMLElement>() {
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null)
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<T>(null)

  const updateAnchorRect = useCallback(() => {
    setAnchorRect(triggerRef.current?.getBoundingClientRect() ?? null)
  }, [])

  useEffect(() => {
    if (!open) {
      return
    }

    window.addEventListener('resize', updateAnchorRect)
    window.addEventListener('scroll', updateAnchorRect, true)
    return () => {
      window.removeEventListener('resize', updateAnchorRect)
      window.removeEventListener('scroll', updateAnchorRect, true)
    }
  }, [open, updateAnchorRect])

  return { anchorRect, open, setOpen, triggerRef, updateAnchorRect }
}
