export type ProducerProjectMediaKind = 'image' | 'video'

export interface ProducerProjectMediaItem {
  assetId?: string
  filename?: string
  key: string
  kind: ProducerProjectMediaKind
  ossUrl?: string
  thumbnailUrl?: string
  url: string
}
