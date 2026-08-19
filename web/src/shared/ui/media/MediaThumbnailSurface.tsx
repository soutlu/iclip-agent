import type { ComposerMediaType } from '@/shared/composer/composer.types'
import { cn } from '@/shared/lib/utils'
import { createOssVideoSnapshotUrl } from '@/shared/ui/media/oss-video-snapshot.utils'

interface MediaThumbnailSurfaceProps {
  className: string
  fileName: string
  mediaType: ComposerMediaType
  thumbnailUrl?: string
  url: string
}

const VIDEO_THUMBNAIL_TIME_FRAGMENT = 't=0.001'

/**
 * 为没有独立封面的源视频指定一个可解码的首帧时间点。
 *
 * @param videoUrl - 原始视频地址。
 * @returns 带媒体时间片段的地址；已有 hash 会被替换。
 */
const createVideoFirstFrameUrl = (videoUrl: string) => {
  const fragmentIndex = videoUrl.indexOf('#')
  const sourceUrl = fragmentIndex === -1 ? videoUrl : videoUrl.slice(0, fragmentIndex)
  return `${sourceUrl}#${VIDEO_THUMBNAIL_TIME_FRAGMENT}`
}

/**
 * 渲染视频缩略图内容。
 *
 * @param props - 视频缩略图属性。
 * @param props.fileName - 视频展示名。
 * @param props.thumbnailUrl - 已知的视频封面 URL。
 * @param props.url - 视频原始 URL，用于推导 OSS 首帧截图。
 * @returns 视频封面或兜底背景元素。
 */
function VideoThumbnailSurface({
  fileName,
  thumbnailUrl,
  url,
}: Pick<MediaThumbnailSurfaceProps, 'fileName' | 'thumbnailUrl' | 'url'>) {
  const snapshotUrl = thumbnailUrl?.trim() || createOssVideoSnapshotUrl(url)

  if (snapshotUrl) {
    return (
      <span
        className="absolute inset-0 bg-cover bg-center bg-no-repeat"
        style={{ backgroundImage: `url("${snapshotUrl}")` }}
        title={`${fileName} 预览`}
      />
    )
  }

  return (
    <video
      aria-hidden="true"
      className="absolute inset-0 h-full w-full object-cover"
      muted
      playsInline
      preload="metadata"
      src={createVideoFirstFrameUrl(url)}
    />
  )
}

/**
 * 渲染音频附件的兜底缩略面。
 *
 * @returns 带音频符号的缩略面元素。
 */
function AudioThumbnailSurface() {
  return (
    <span className="absolute inset-0 flex items-center justify-center bg-[image:var(--media-gloss)] text-white">
      <svg aria-hidden="true" width="18" height="18" viewBox="0 0 256 256" fill="currentColor">
        <title>音频</title>
        <path d="M210.3,56.8A8,8,0,0,0,203,56H96A16,16,0,0,0,80,72V168.4A31.8,31.8,0,0,0,64,164c-17.6,0-32,12.1-32,27s14.4,27,32,27,32-12.1,32-27V112H200v56.4A31.8,31.8,0,0,0,184,164c-17.6,0-32,12.1-32,27s14.4,27,32,27,32-12.1,32-27V64A8,8,0,0,0,210.3,56.8ZM96,96V72H200V96Z" />
      </svg>
    </span>
  )
}

/**
 * 渲染图片、视频或音频的统一缩略面。
 *
 * @param props - 媒体缩略面属性。
 * @param props.className - 注入到外层缩略面的样式类。
 * @param props.fileName - 媒体展示名。
 * @param props.mediaType - 媒体类型。
 * @param props.thumbnailUrl - 可选缩略图 URL。
 * @param props.url - 原始媒体 URL。
 * @returns 图片背景、OSS 视频首帧或兜底缩略面。
 */
export default function MediaThumbnailSurface({
  className,
  fileName,
  mediaType,
  thumbnailUrl,
  url,
}: MediaThumbnailSurfaceProps) {
  if (mediaType === 'image') {
    return (
      <span
        aria-hidden="true"
        className={cn(className, 'pointer-events-none bg-cover bg-center bg-no-repeat')}
        style={{ backgroundImage: `url("${thumbnailUrl ?? url}")` }}
      />
    )
  }

  if (mediaType === 'audio') {
    return (
      <span
        aria-hidden="true"
        className={cn(
          className,
          'pointer-events-none relative overflow-hidden bg-[var(--color-thumb-fallback)]',
        )}
      >
        <AudioThumbnailSurface />
      </span>
    )
  }

  return (
    <span
      aria-hidden="true"
      className={cn(
        className,
        'pointer-events-none relative overflow-hidden bg-[var(--color-thumb-fallback)]',
      )}
    >
      <VideoThumbnailSurface fileName={fileName} thumbnailUrl={thumbnailUrl} url={url} />
    </span>
  )
}
