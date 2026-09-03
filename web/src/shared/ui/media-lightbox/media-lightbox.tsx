/**
 * 图片灯箱（照 kimi media-lightbox 的形）：整页遮罩 + 居中图片 + 右上关闭。
 * ESC、点遮罩、点关闭钮都关；遮罩本身是个通铺按钮，键盘与读屏都摸得到关闭路径。
 *
 * 视频不进灯箱（点开新页）：用户自己传的视频没有字幕轨可挂，硬塞进 <video> 只会触发
 * a11y 规则；等视频附件真正流动起来再补带字幕声明的播放器。
 */

import { useEffect } from 'react'
import { Icon } from '@/shared/icons'

/** 灯箱里看的那张：地址加给读屏与标题用的名字。 */
export type LightboxMedia = { url: string; name: string }

type MediaLightboxProps = {
  /** 正在看的那张；null 即关闭。 */
  media: LightboxMedia | null
  onClose: () => void
}

/**
 * 渲染灯箱。
 *
 * @param props - 组件属性。
 * @param props.media - 要看的那张。
 * @param props.onClose - 关闭。
 * @returns 灯箱；关着就不渲染。
 */
export function MediaLightbox({ media, onClose }: MediaLightboxProps) {
  useEffect(() => {
    if (media === null) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [media, onClose])

  if (media === null) return null

  return (
    <div
      aria-label={media.name}
      aria-modal="true"
      className="chat-lightbox layer-overlay fixed inset-0 grid animate-in place-items-center p-6 duration-(--dur-m) fade-in"
      role="dialog"
    >
      <button
        aria-label="关闭预览"
        className="absolute inset-0 cursor-zoom-out"
        onClick={onClose}
        type="button"
      />
      <img
        alt={media.name}
        className="chat-lightbox-media relative animate-in duration-(--dur-m) zoom-in-95"
        src={media.url}
      />
      <button
        aria-label="关闭"
        className="absolute top-4 right-6 grid size-(--control-height-md) cursor-pointer place-items-center rounded-full text-on-scrim ui-focus ui-motion-s hover:opacity-70"
        onClick={onClose}
        type="button"
      >
        <Icon decorative name="close" size="lg" />
      </button>
    </div>
  )
}
