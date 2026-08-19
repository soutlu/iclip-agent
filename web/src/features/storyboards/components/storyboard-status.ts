import type { StoryboardStatus } from '@/features/storyboards/model/storyboard-workspace'

/** Storyboard Brief 生命周期在界面中的统一中文文案。 */
export const STORYBOARD_STATUS_LABELS: Record<StoryboardStatus, string> = {
  confirmed: '已确认',
  draft: '待确认',
  submitted: '已提交',
}
