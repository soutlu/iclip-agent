import { useReactFlow } from '@xyflow/react'
import { useCallback, useEffect, useRef } from 'react'

const GLOW_RADIUS = 100
const GLOW_FADE_DURATION = 800
const GLOW_RAMP_DURATION = 500
const EMPTY_MASK = 'linear-gradient(transparent, transparent)'
const MAX_GLOW_ZOOM_FACTOR = 6
const MAX_GLOW_ALPHA_BOOST = 4

interface MouseGlowState {
  alpha: number
  lastMoveTime: number
  startTime: number
  x: number
  y: number
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

const setMaskImage = (element: SVGSVGElement | HTMLDivElement, value: string) => {
  element.style.maskImage = value
  Reflect.set(element.style, 'webkitMaskImage', value)
}

export default function ProjectCanvasGlow() {
  const { getZoom } = useReactFlow()

  const animationFrameRef = useRef<number | null>(null)
  const glowBackgroundRef = useRef<SVGSVGElement | null>(null)
  const mouseGlowRef = useRef<MouseGlowState | null>(null)
  const scopeRef = useRef<HTMLDivElement>(null)

  const resolveGlowBackground = useCallback(() => {
    if (glowBackgroundRef.current?.isConnected) {
      return glowBackgroundRef.current
    }

    glowBackgroundRef.current = null

    const reactFlowRoot = scopeRef.current?.closest('.react-flow')

    if (!reactFlowRoot) {
      return null
    }

    const backgrounds = reactFlowRoot.querySelectorAll<SVGSVGElement>('.react-flow__background')
    const glowBackground = backgrounds[1]

    if (!glowBackground) {
      return null
    }

    setMaskImage(glowBackground, EMPTY_MASK)
    glowBackground.style.opacity = '0'
    glowBackgroundRef.current = glowBackground

    return glowBackground
  }, [])

  const applyGlowMask = useCallback(() => {
    const glowLayer = resolveGlowBackground()
    const state = mouseGlowRef.current

    if (!glowLayer) {
      return
    }

    if (!state || state.alpha <= 0.01) {
      glowLayer.style.opacity = '0'
      setMaskImage(glowLayer, EMPTY_MASK)
      return
    }

    const zoomFactor = clamp(
      Math.min(1 / Math.max(getZoom() || 1, 0.05), MAX_GLOW_ZOOM_FACTOR),
      1,
      MAX_GLOW_ALPHA_BOOST,
    )
    const alpha = Math.min(state.alpha * zoomFactor, 1)
    const maskImage = `radial-gradient(circle ${GLOW_RADIUS}px at ${state.x}px ${state.y}px, color-mix(in srgb, var(--color-scrim) ${alpha * 100}%, transparent) 0%, color-mix(in srgb, var(--color-scrim) ${
      alpha * 80
    }%, transparent) 25%, color-mix(in srgb, var(--color-scrim) ${alpha * 40}%, transparent) 55%, transparent 100%)`

    glowLayer.style.opacity = '1'
    setMaskImage(glowLayer, maskImage)
  }, [getZoom, resolveGlowBackground])

  const animateGlow = useCallback(() => {
    const tick = () => {
      const state = mouseGlowRef.current

      if (!state) {
        animationFrameRef.current = null
        return
      }

      const now = performance.now()
      const sinceLastMove = now - state.lastMoveTime
      const sinceStart = now - state.startTime

      if (sinceStart < GLOW_RAMP_DURATION) {
        const progress = sinceStart / GLOW_RAMP_DURATION
        state.alpha = 1 - (1 - progress) * (1 - progress)
      } else if (sinceLastMove > 0) {
        const progress = Math.min(sinceLastMove / GLOW_FADE_DURATION, 1)
        state.alpha = 1 - progress * progress
      }

      applyGlowMask()

      if (state.alpha > 0.01 || sinceStart < GLOW_RAMP_DURATION) {
        animationFrameRef.current = requestAnimationFrame(tick)
        return
      }

      mouseGlowRef.current = null
      animationFrameRef.current = null
      applyGlowMask()
    }

    tick()
  }, [applyGlowMask])

  const ensureAnimation = useCallback(() => {
    if (animationFrameRef.current === null) {
      animationFrameRef.current = requestAnimationFrame(() => {
        animationFrameRef.current = null
        animateGlow()
      })
    }
  }, [animateGlow])

  useEffect(() => {
    applyGlowMask()
  }, [applyGlowMask])

  useEffect(() => {
    const timers = [0, 100, 300, 800, 2000].map((delay) =>
      window.setTimeout(() => resolveGlowBackground(), delay),
    )

    return () => {
      for (const timer of timers) {
        window.clearTimeout(timer)
      }
    }
  }, [resolveGlowBackground])

  useEffect(() => {
    const handleMouseMove = (event: MouseEvent) => {
      const glowBackground = resolveGlowBackground()

      if (!glowBackground) {
        return
      }

      const rect = glowBackground.getBoundingClientRect()

      if (
        event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom
      ) {
        return
      }

      const x = event.clientX - rect.left
      const y = event.clientY - rect.top
      const now = performance.now()

      if (mouseGlowRef.current) {
        mouseGlowRef.current.x = x
        mouseGlowRef.current.y = y
        mouseGlowRef.current.lastMoveTime = now
      } else {
        mouseGlowRef.current = {
          alpha: 0,
          lastMoveTime: now,
          startTime: now,
          x,
          y,
        }
      }

      ensureAnimation()
    }

    window.addEventListener('mousemove', handleMouseMove)

    return () => {
      window.removeEventListener('mousemove', handleMouseMove)

      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current)
      }
    }
  }, [ensureAnimation, resolveGlowBackground])

  return <div ref={scopeRef} style={{ display: 'none' }} />
}
