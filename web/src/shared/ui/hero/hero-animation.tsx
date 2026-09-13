import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, PointerEvent } from 'react'
import { cn } from '@/shared/lib/utils'
import { CueMascot } from './cue-mascot'
import mascotMarkup from './cue-mmt.svg?raw'

type HeroAnimationProps = {
  className?: string
}

const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

/** 首页吉祥物：内联 cue-mmt.svg，悬停展开、移开收起、点击固定、Escape 收起；减少动态效果时定格在展开态。Cue 字标用 currentColor，随主题变色。 */
export function HeroAnimation({ className }: HeroAnimationProps) {
  const hostRef = useRef<HTMLButtonElement>(null)
  const mascotRef = useRef<CueMascot | null>(null)
  const [expanded, setExpanded] = useState(prefersReducedMotion)
  const [pinned, setPinned] = useState(false)

  // SVG 是构建期静态资源，挂载时注入；按钮不带 React 子节点，React 不会覆盖它。
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    host.innerHTML = mascotMarkup
    const svg = host.querySelector('svg')
    if (!svg) return
    const mascot = new CueMascot(svg)
    mascotRef.current = mascot
    return () => {
      mascot.destroy()
      mascotRef.current = null
      host.replaceChildren()
    }
  }, [])

  useEffect(() => {
    mascotRef.current?.setExpanded(expanded)
  }, [expanded])

  const hoverStart = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.pointerType !== 'touch') setExpanded(true)
  }
  const hoverEnd = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.pointerType !== 'touch' && !pinned) setExpanded(false)
  }
  const toggle = () => {
    setPinned(!pinned)
    setExpanded(!pinned)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Escape') {
      setPinned(false)
      setExpanded(false)
    }
  }

  return (
    <button
      ref={hostRef}
      aria-expanded={expanded}
      aria-label={expanded ? '收起鞋盒' : '展开鞋盒，展示鞋履与服装'}
      className={cn(
        'block aspect-[2/1] cursor-pointer rounded-lg text-on-surface ui-focus [&_svg]:block [&_svg]:size-full',
        className,
      )}
      onClick={toggle}
      onKeyDown={onKeyDown}
      onPointerEnter={hoverStart}
      onPointerLeave={hoverEnd}
      type="button"
    />
  )
}
