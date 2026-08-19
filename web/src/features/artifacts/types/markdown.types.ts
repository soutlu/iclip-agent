/**
 * Markdown artifact 对应的来源媒体。
 */
export interface MarkdownArtifactSourceMedia {
  filename?: string
  key: string
  kind: 'image' | 'video'
  ossUrl?: string
  thumbnailUrl?: string
  url: string
}

/**
 * 通用 Markdown artifact 的前端展示数据。
 */
export interface MarkdownArtifactOutput {
  markdown: string
  sourceMedia?: MarkdownArtifactSourceMedia
  title: string
}
