import { useEffect, useRef } from 'react'
import { cn } from '@/shared/lib/utils'

const ANIMATION_PATH = '/lottie/hero.json'

type HeroAnimationProps = {
  className?: string
}

/**
 * 剪辑现场插画，5 秒循环，当前只用于首页空态。
 *
 * 只有一份产物：深色配色由 hero.css 用 CSS 盖掉烤进 JSON 的颜色（lottie 把 fill 写成
 * 呈现属性，作者 CSS 压得住它），不再靠第二份深色 JSON，也不必跟着色板重跑生成脚本。
 * 因此这里不观察主题，换主题时播放器不重建。
 *
 * 播放器是 JS 驱动的，逃得过全局那条 prefers-reduced-motion 规则，所以要自己判：
 * 用户要求减弱动效时不自动播放，停在首帧当静态插画。
 *
 * 播放器动态引入：它在模块加载时就探 canvas 2d context，静态 import 会让每个引到本
 * 组件的模块（含测试）在 jsdom 里直接抛；顺带把这 165KB 挪出首屏 chunk。
 *
 * @param props - 组件属性。
 * @param props.className - 追加到容器上的类名，尺寸由调用方决定。
 * @returns 装饰性插画（aria-hidden，含义由页面标题承担）。
 */
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

    // 原图画布 9261×6174，内容四周留白约 15%：裁到内容框，否则插画与上下元素之间
    // 总隔着一截空画布。数值按内容包围盒实测（换插画要重采，同 hero.css 的采色约定）。
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

  // cue-hero 是 hero.css 的作用域；占位宽高比与上面裁切后的 viewBox 一致，先占位再填充，
  // 加载完不会把下面的内容顶一下
  return <div ref={hostRef} aria-hidden className={cn('cue-hero aspect-[7832/4666]', className)} />
}
