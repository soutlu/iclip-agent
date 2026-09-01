/** 模型运行状态条：结构与生命周期照 Kimi Code 的 WorkingIndicator。 */

import { useEffect, useRef } from 'react'
import type { AnimationItem } from 'lottie-web'

const CAMERA_VIEW_BOX = '65 70 320 270'
const ANIMATION_PATH = '/lottie/requesting-camera.json'

type WorkingIndicatorProps = {
  label: string
}

export function WorkingIndicator({ label }: WorkingIndicatorProps) {
  return (
    <div className="inline-flex items-center gap-2 text-body-sm text-chat-muted-text" role="status">
      <CameraMascot />
      <span className="animate-pulse">{label}</span>
    </div>
  )
}

function CameraMascot() {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current
    if (host === null) return

    let animation: AnimationItem | undefined
    let cancelled = false

    const crop = () => host.querySelector('svg')?.setAttribute('viewBox', CAMERA_VIEW_BOX)

    void import('lottie-web/build/player/lottie_light').then(({ default: lottie }) => {
      if (cancelled) return

      animation = lottie.loadAnimation({
        autoplay: !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
        container: host,
        loop: true,
        path: ANIMATION_PATH,
        renderer: 'svg',
      })
      animation.addEventListener('DOMLoaded', crop)
    })

    return () => {
      cancelled = true
      animation?.removeEventListener('DOMLoaded', crop)
      animation?.destroy()
    }
  }, [])

  return <div aria-hidden className="size-10 shrink-0" ref={hostRef} />
}
