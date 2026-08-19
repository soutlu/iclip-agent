export interface UiCardKeyValueRow {
  label: string
  value: string
}

export interface UiCardMetricItem {
  label: string
  value: string
}

export interface UiCardParagraphSection {
  text: string
  type: 'paragraph'
}

export interface UiCardKeyValueSection {
  rows: UiCardKeyValueRow[]
  type: 'keyValue'
}

export interface UiCardListSection {
  items: string[]
  type: 'list'
}

export interface UiCardMetricGridSection {
  items: UiCardMetricItem[]
  type: 'metricGrid'
}

export interface UiCardMediaSection {
  alt: string
  aspectRatio?: number
  src: string
  type: 'media'
}

export interface UiCardTagRowSection {
  items: string[]
  type: 'tagRow'
}

export type UiCardSection =
  | UiCardKeyValueSection
  | UiCardListSection
  | UiCardMediaSection
  | UiCardMetricGridSection
  | UiCardParagraphSection
  | UiCardTagRowSection

export interface UiCardArtifactOutput {
  badges?: string[]
  sections: UiCardSection[]
  subtitle?: string
  title: string
}
