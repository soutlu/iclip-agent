import type { ComposerMediaType } from '@/shared/composer/composer.types'
import MediaThumbnailSurface from './MediaThumbnailSurface'

interface InlineMediaThumbnailProps {
  className: string
  fileName: string
  mediaType: ComposerMediaType
  thumbnailUrl?: string
  url: string
}

export default function InlineMediaThumbnail({
  className,
  fileName,
  mediaType,
  thumbnailUrl,
  url,
}: InlineMediaThumbnailProps) {
  const mediaLabel = mediaType === 'audio' ? '音频' : mediaType === 'image' ? '图片' : '视频'

  if (mediaType === 'image') {
    return (
      <MediaThumbnailSurface
        className={className}
        fileName={fileName}
        mediaType={mediaType}
        thumbnailUrl={thumbnailUrl}
        url={url}
      />
    )
  }

  return (
    <span className="relative block">
      <MediaThumbnailSurface
        className={className}
        fileName={fileName}
        mediaType={mediaType}
        thumbnailUrl={thumbnailUrl}
        url={url}
      />
      <span className="absolute right-0.5 bottom-0.5 inline-flex h-3.5 w-3.5 items-center justify-center rounded-full bg-black/55 text-white">
        <span className="sr-only">{`${fileName} 是${mediaLabel}`}</span>
        <span aria-hidden="true" className="inline-flex h-full w-full items-center justify-center">
          <svg width="7" height="7" viewBox="0 0 256 256" fill="currentColor">
            <title>{mediaLabel}</title>
            {mediaType === 'audio' ? (
              <path d="M210.3,56.8A8,8,0,0,0,203,56H96A16,16,0,0,0,80,72V168.4A31.8,31.8,0,0,0,64,164c-17.6,0-32,12.1-32,27s14.4,27,32,27,32-12.1,32-27V112H200v56.4A31.8,31.8,0,0,0,184,164c-17.6,0-32,12.1-32,27s14.4,27,32,27,32-12.1,32-27V64A8,8,0,0,0,210.3,56.8ZM96,96V72H200V96Z" />
            ) : (
              <path d="M232,128a8,8,0,0,1-3.47,6.59l-144,88A8,8,0,0,1,72,216V40a8,8,0,0,1,12.53-6.59l144,88A8,8,0,0,1,232,128Z" />
            )}
          </svg>
        </span>
      </span>
    </span>
  )
}
