import { useCallback, useEffect, useRef, useState } from 'react'

/** 打开前先测量锚点再 setOpen，避免首帧使用旧位置；打开期间跟随窗口缩放和滚动更新。 */
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
