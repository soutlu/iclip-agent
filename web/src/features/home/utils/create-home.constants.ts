import type { ProducerProjectKind } from '@/features/projects'

export const HOME_HERO_TITLE = 'Producer Studio is here'

export const HOME_COMPOSER_MODES = [
  { label: 'Agent', value: 'agent' },
  { label: 'Video', value: 'video' },
] as const

export const HOME_DEFAULT_COMPOSER_MODE = 'video'

export const PROJECT_TITLE_MAX_LENGTH = 200

export interface RecentProjectItem {
  id: string
  kind: ProducerProjectKind
  title: string
  updatedAt: string
}

export interface RecentProjectGroup {
  items: RecentProjectItem[]
  label: string
}
