export const IMAGE_ANALYSIS_SUMMARY_NODE_TITLE = '输入图片'

export interface ImageAnalysisSummaryItem {
  category: string
  description: string
  filename?: string
  key: string
  thumbnailUrl?: string
  url?: string
}

export interface ImageAnalysisSummaryOutput {
  items: ImageAnalysisSummaryItem[]
}
