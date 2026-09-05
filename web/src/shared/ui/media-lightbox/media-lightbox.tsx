import { useEffect } from 'react'
import { Icon } from '@/shared/icons'

export type LightboxMedia = { kind: 'image' | 'video'; url: string; name: string }

type MediaLightboxProps = {
  media: LightboxMedia | null
  onClose: () => void
}

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
      {media.kind === 'video' ? (
        // eslint-disable-next-line jsx-a11y-x/media-has-caption -- 用户自己传的素材没有字幕轨可挂
        <video
          aria-label={media.name}
          autoPlay
          className="chat-lightbox-media relative animate-in duration-(--dur-m) zoom-in-95"
          controls
          src={media.url}
        />
      ) : (
        <img
          alt={media.name}
          className="chat-lightbox-media relative animate-in duration-(--dur-m) zoom-in-95"
          src={media.url}
        />
      )}
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
