import type { WebInspirationPlatform } from '@/features/tasks/api/inspiration.api'

const WEB_INSPIRATION_PLATFORM_LABELS: Readonly<Record<WebInspirationPlatform, string>> = {
  instagram: 'Instagram',
  tiktok: 'TikTok',
  youtube: 'YouTube',
}

export const webInspirationPlatformLabel = (platform: WebInspirationPlatform) =>
  WEB_INSPIRATION_PLATFORM_LABELS[platform]

/** 只从受控 provider 与平台视频 id 构造官方播放器地址，绝不把帖子 URL 当媒体源。 */
export const resolveWebInspirationEmbedUrl = (
  platform: WebInspirationPlatform,
  platformVideoId: string,
  origin: string,
): null | string => {
  const videoId = encodeURIComponent(platformVideoId)
  if (platform === 'tiktok') {
    return `https://www.tiktok.com/player/v1/${videoId}`
  }
  if (platform === 'youtube') {
    const url = new URL(`https://www.youtube.com/embed/${videoId}`)
    url.searchParams.set('playsinline', '1')
    url.searchParams.set('origin', origin)
    return url.toString()
  }
  if (platform === 'instagram') {
    return `https://www.instagram.com/reel/${videoId}/embed`
  }
  return null
}
