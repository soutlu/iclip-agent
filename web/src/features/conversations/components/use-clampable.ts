import { useLayoutEffect, useRef, useState } from 'react'

/**
 * 量出内容是否超过给定行数：超高才折叠（折叠遮罩的渐隐按 100% 定位，矮内容套上会被整个
 * 隐没）。行高取计算样式，拿不到就按 字号 × 1.5 估。
 *
 * @param lines - 折叠阈值（行）。
 * @param content - 内容；变了重新量。
 * @returns 测量 ref 与是否可折叠。
 */
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
