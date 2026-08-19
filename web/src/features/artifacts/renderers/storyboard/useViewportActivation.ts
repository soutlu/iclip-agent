import { useCallback, useEffect, useState } from 'react'

interface UseViewportActivationOptions {
  enabled?: boolean
  rootMargin?: string
  threshold?: number
}

const useViewportActivation = <T extends HTMLElement>({
  enabled = true,
  rootMargin = '240px 0px',
  threshold = 0.15,
}: UseViewportActivationOptions = {}) => {
  const [hasActivated, setHasActivated] = useState(!enabled)
  const [node, setNode] = useState<T | null>(null)

  useEffect(() => {
    if (!enabled) {
      setHasActivated(true)
      return
    }

    setHasActivated(false)
  }, [enabled])

  useEffect(() => {
    if (!enabled || hasActivated || !node) {
      return
    }

    if (typeof globalThis.IntersectionObserver !== 'function') {
      setHasActivated(true)
      return
    }

    const observer = new globalThis.IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) {
          return
        }

        setHasActivated(true)
        observer.disconnect()
      },
      {
        rootMargin,
        threshold,
      },
    )

    observer.observe(node)

    return () => observer.disconnect()
  }, [enabled, hasActivated, node, rootMargin, threshold])

  const activate = useCallback(() => {
    setHasActivated(true)
  }, [])

  const ref = useCallback((nextNode: T | null) => {
    setNode(nextNode)
  }, [])

  return {
    activate,
    hasActivated,
    ref,
  }
}

export default useViewportActivation
