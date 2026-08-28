import { useEffect, useRef } from 'react'
import { cn } from '@/shared/lib/utils'

const ANIMATION_PATH = '/lottie/hero.json'

type HeroAnimationProps = {
  className?: string
}

/**
 * 剪辑现场插画，5 秒循环。首页与登录页共用。
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

    let animation: { destroy: () => void } | undefined
    let cancelled = false

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
    })

    return () => {
      cancelled = true
      animation?.destroy()
    }
  }, [])

  // producer-hero 是 hero.css 的作用域；插画自身宽高比 3:2，先占位再填充，
  // 加载完不会把下面的内容顶一下
  return <div ref={hostRef} aria-hidden className={cn('producer-hero aspect-3/2', className)} />
}
