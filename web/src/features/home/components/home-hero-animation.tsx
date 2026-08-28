import lottie from 'lottie-web/build/player/lottie_light'
import { useEffect, useRef, useState } from 'react'

/** 两套配色各一份产物：只有当前主题那份会被下载。 */
const ANIMATION_SOURCE = {
  dark: '/lottie/home-hero-dark.json',
  light: '/lottie/home-hero-light.json',
}

const isDarkTheme = () => document.documentElement.classList.contains('dark')

/**
 * 首页 hero 动画：剪辑现场插画，5 秒循环。
 *
 * 深浅两套是两份产物，不是运行时改色——Lottie 的颜色烤在图形里，取不到 CSS 变量。
 * 主题只有 <html>.dark 一个开关（app/theme.ts），这里只观察它，不自持主题状态；
 * 系统主题切换时整个播放器重建，换加载另一份。
 *
 * 播放器是 JS 驱动的，逃得过全局那条 prefers-reduced-motion 规则，所以要自己判：
 * 用户要求减弱动效时不自动播放，停在首帧当静态插画。
 *
 * @returns 装饰性 hero 动画（aria-hidden，品牌名由 sr-only 标题承担）。
 */
export function HomeHeroAnimation() {
  const hostRef = useRef<HTMLDivElement>(null)
  const [dark, setDark] = useState(isDarkTheme)

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setDark(isDarkTheme())
    })

    observer.observe(document.documentElement, { attributeFilter: ['class'] })

    return () => {
      observer.disconnect()
    }
  }, [])

  useEffect(() => {
    const host = hostRef.current

    if (!host) {
      return
    }

    const animation = lottie.loadAnimation({
      autoplay: !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      container: host,
      loop: true,
      path: dark ? ANIMATION_SOURCE.dark : ANIMATION_SOURCE.light,
      renderer: 'svg',
    })

    return () => {
      animation.destroy()
    }
  }, [dark])

  return (
    <div
      ref={hostRef}
      aria-hidden
      // 插画自身宽高比 3:2；先占位再填充，加载完不会把下面的输入卡顶一下
      className="aspect-3/2 w-[min(520px,90vw)] animate-in duration-(--dur-l) fade-in"
    />
  )
}
