import type { CSSProperties, ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { cn } from '@/shared/lib/utils'

interface ScrollMaskRailProps {
  children: ReactNode
  className?: string
  maskOffset?: number
}

export default function ScrollMaskRail({
  children,
  className = '',
  maskOffset = 24,
}: ScrollMaskRailProps) {
  const railRef = useRef<HTMLDivElement>(null)
  const [showMask, setShowMask] = useState(false)

  useEffect(() => {
    const rail = railRef.current
    if (!rail) {
      return undefined
    }

    const updateMask = () => {
      setShowMask(rail.scrollLeft + rail.clientWidth < rail.scrollWidth - 1)
    }

    updateMask()

    const resizeObserver = new ResizeObserver(updateMask)
    resizeObserver.observe(rail)
    rail.addEventListener('scroll', updateMask, { passive: true })

    return () => {
      resizeObserver.disconnect()
      rail.removeEventListener('scroll', updateMask)
    }
  }, [])

  const railStyle: CSSProperties | undefined = showMask
    ? {
        maskImage: `linear-gradient(to right, black calc(100% - ${maskOffset}px), transparent)`,
        WebkitMaskImage: `linear-gradient(to right, black calc(100% - ${maskOffset}px), transparent)`,
      }
    : undefined

  return (
    <div
      ref={railRef}
      className={cn('hide-scrollbar flex flex-nowrap gap-2 overflow-x-auto', className)}
      style={railStyle}
    >
      {children}
    </div>
  )
}
