const OSS_VIDEO_SNAPSHOT_PROCESS = 'video/snapshot,t_0,f_jpg,w_800,h_0,m_fast,ar_auto'
const ALIYUN_OSS_HOST_PATTERN = /(^|\.)oss(?:-[a-z0-9-]+)?\.aliyuncs\.com$/i

const OSS_SIGNED_QUERY_KEYS = new Set([
  'expires',
  'ossaccesskeyid',
  'signature',
  'x-oss-credential',
  'x-oss-date',
  'x-oss-expires',
  'x-oss-security-token',
  'x-oss-signature',
  'x-oss-signature-version',
])

/**
 * 判断 URL 查询参数中是否包含 OSS 签名字段。
 *
 * @param searchParams - 已解析的 URL 查询参数。
 * @returns 包含签名字段时返回 true。
 */
const hasSignedQuery = (searchParams: URLSearchParams) => {
  for (const key of searchParams.keys()) {
    if (OSS_SIGNED_QUERY_KEYS.has(key.toLowerCase())) {
      return true
    }
  }

  return false
}

/**
 * 根据阿里云 OSS 标准域名下的公开视频地址生成首帧截图地址。
 *
 * @param videoUrl - 公开可访问的视频 URL。
 * @returns 可用于图片缩略图的 OSS 截帧 URL；非 OSS、非 HTTP 或签名 URL 返回 undefined。
 */
export const createOssVideoSnapshotUrl = (videoUrl: string) => {
  try {
    const url = new URL(videoUrl)

    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      !ALIYUN_OSS_HOST_PATTERN.test(url.hostname)
    ) {
      return undefined
    }

    if (url.searchParams.has('x-oss-process') || hasSignedQuery(url.searchParams)) {
      return undefined
    }

    url.searchParams.set('x-oss-process', OSS_VIDEO_SNAPSHOT_PROCESS)
    return url.toString()
  } catch {
    return undefined
  }
}
