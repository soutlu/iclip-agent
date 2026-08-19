const EMBEDDED_URL_PATTERN = /(?:https?:\/\/|blob:|data:image\/)[^\s<>"'`\\]+/giu
const IMAGE_FIELD_HINT = /(cover|frame|image|img|photo|picture|poster|sheet|thumb)/i
const IMAGE_FILE_EXTENSION = /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)$/i
const NON_IMAGE_MEDIA_EXTENSION =
  /\.(?:aac|avi|flac|m4a|m4v|mkv|mov|mp3|mp4|mpeg|mpg|oga|ogg|ogv|wav|webm)$/i
const TRAILING_URL_PUNCTUATION = /[),.;\]}，。；）】〉》」』]+$/u

const isImageMediaRecord = (record: Record<string, unknown>) =>
  ['assetType', 'contentType', 'mediaType', 'mimeType', 'type'].some((key) => {
    const value = record[key]
    return typeof value === 'string' && /^(?:image(?:\/|$)|photo$|picture$)/i.test(value.trim())
  })

const stringUrlCandidates = (value: string) => {
  const candidates: string[] = value.match(EMBEDDED_URL_PATTERN) ?? []
  const trimmed = value.trim()

  if (/^(?:\/\/|\/[^/]|https?:\/\/|blob:|data:image\/)/i.test(trimmed)) {
    candidates.unshift(trimmed)
  }

  return candidates.map((candidate) => candidate.replace(TRAILING_URL_PUNCTUATION, ''))
}

const isImageUrl = (candidate: string, imageContext: boolean) => {
  if (/^data:image\//i.test(candidate)) return true

  let parsedUrl: URL
  try {
    parsedUrl = new URL(candidate, 'https://producer.invalid')
  } catch {
    return false
  }

  if (!['blob:', 'http:', 'https:'].includes(parsedUrl.protocol)) return false

  let pathname = parsedUrl.pathname
  try {
    pathname = decodeURIComponent(pathname)
  } catch {
    // URL 仍可用于展示；扩展名判断退回编码后的 pathname。
  }

  if (NON_IMAGE_MEDIA_EXTENSION.test(pathname)) return false
  if (IMAGE_FILE_EXTENSION.test(pathname)) return true

  const ossProcess = parsedUrl.searchParams.get('x-oss-process')
  if (ossProcess?.toLowerCase().includes('image')) return true

  return imageContext
}

/**
 * 从未知工具结果中提取可明确判定为图片的 URL。
 *
 * 图片扩展名、data image、OSS 图片处理参数可直接判定；无扩展名 URL 只有位于
 * image/frame/sheet 等语义字段，或对象显式声明 image media type 时才会采用。
 */
export const imageUrlsFromToolResult = (result: unknown): string[] => {
  const imageUrls: string[] = []
  const seenUrls = new Set<string>()
  const visitedObjects = new WeakSet<object>()

  const collect = (value: unknown, imageContext: boolean) => {
    if (typeof value === 'string') {
      for (const candidate of stringUrlCandidates(value)) {
        if (!isImageUrl(candidate, imageContext) || seenUrls.has(candidate)) continue
        seenUrls.add(candidate)
        imageUrls.push(candidate)
      }
      return
    }

    if (typeof value !== 'object' || value === null || visitedObjects.has(value)) return
    visitedObjects.add(value)

    if (Array.isArray(value)) {
      for (const item of value) collect(item, imageContext)
      return
    }

    const record = value as Record<string, unknown>
    const recordIsImage = imageContext || isImageMediaRecord(record)

    for (const [key, item] of Object.entries(record)) {
      collect(item, recordIsImage || IMAGE_FIELD_HINT.test(key))
    }
  }

  collect(result, false)
  return imageUrls
}
