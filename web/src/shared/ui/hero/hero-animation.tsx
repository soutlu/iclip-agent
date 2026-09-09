import { useEffect, useRef } from 'react'
import { cn } from '@/shared/lib/utils'

const ANIMATION_PATH = '/lottie/hero.json'

type HeroAnimationProps = {
  className?: string
}

/** hero.css 覆盖 Lottie 呈现属性以切换深色；JS 动画单独处理 reduced-motion。动态导入避免模块加载时探测 canvas，并拆分播放器代码。 */
export function HeroAnimation({ className }: HeroAnimationProps) {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current

    if (!host) {
      return
    }

    let animation:
      | {
          addEventListener: (name: 'DOMLoaded', callback: () => void) => void
          removeEventListener: (name: 'DOMLoaded', callback: () => void) => void
          destroy: () => void
        }
      | undefined
    let cancelled = false

    // 裁剪值来自原图内容包围盒；更换插画时须重新测量。
    const cropViewBox = () => {
      host.querySelector('svg')?.setAttribute('viewBox', '600 850 7832 4666')
    }

    void import('lottie-web/build/player/lottie_light').then(({ default: lottie }) => {
      if (cancelled) {
        return
      }

      animation = lottie.loadAnimation({
        autoplay: !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
        container: host,
        loop: true,
        path: ANIMATION_PATH,
        renderer: 'svg',
      })
      animation.addEventListener('DOMLoaded', cropViewBox)
    })

    return () => {
      cancelled = true
      animation?.removeEventListener('DOMLoaded', cropViewBox)
      animation?.destroy()
    }
  }, [])

  // 预留与裁剪 viewBox 一致的宽高比，避免加载后布局偏移。
  return <div ref={hostRef} aria-hidden className={cn('cue-hero aspect-[7832/4666]', className)} />
}
