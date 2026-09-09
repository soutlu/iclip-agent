import { useLayoutEffect, useRef, useState } from 'react'

/** 仅对超出指定行数的内容应用渐隐，避免短内容被遮蔽；无行高时按字号的 1.5 倍估算。 */
export function useClampable(lines: number, content: unknown) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [clampable, setClampable] = useState(false)

  useLayoutEffect(() => {
    const el = ref.current
    if (el === null) return
    const style = getComputedStyle(el)
    const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.5 || 21
    setClampable(el.scrollHeight > lines * lineHeight + 1)
  }, [lines, content])

  return { clampable, ref }
}
