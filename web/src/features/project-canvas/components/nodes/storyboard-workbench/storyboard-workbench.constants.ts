import type { CSSProperties } from 'react'
import { type StoryboardScreenToolIconType } from './storyboard-workbench-icons'
import type {
  StoryboardWorkbenchExportAction,
  StoryboardWorkbenchPreviewPanelMetrics,
} from './storyboard-workbench.types'

export const EMPTY_SHOT_ID = 'storyboard-workbench-empty-shot'
export const DEFAULT_STORYBOARD_PREVIEW_ASPECT_RATIO_LABEL = '16:9'
export const DEFAULT_STORYBOARD_PREVIEW_ASPECT_RATIO = 16 / 9
export const ASPECT_RATIO_PART_COUNT = 2
export const STORYBOARD_WORKBENCH_NODE_HEIGHT = 1355
export const STORYBOARD_WORKBENCH_NODE_WIDTH = 2328
export const STORYBOARD_WORKBENCH_SCREEN_MODE_NODE_WIDTH = 1445
export const STORYBOARD_NODE_HEIGHT = STORYBOARD_WORKBENCH_NODE_HEIGHT
export const STORYBOARD_NODE_WIDTH = STORYBOARD_WORKBENCH_NODE_WIDTH
export const STORYBOARD_SCREEN_MODE_NODE_WIDTH = STORYBOARD_WORKBENCH_SCREEN_MODE_NODE_WIDTH
export const STORYBOARD_NODE_BORDER_WIDTH = 3
export const STORYBOARD_PANEL_DIVIDER_WIDTH = 3
export const STORYBOARD_SCRIPT_PANEL_RATIO = 8
export const STORYBOARD_PREVIEW_PANEL_RATIO = 13
export const STORYBOARD_NODE_CONTENT_WIDTH =
  STORYBOARD_NODE_WIDTH - STORYBOARD_NODE_BORDER_WIDTH * 2
export const STORYBOARD_SCRIPT_MODE_PANEL_AREA_WIDTH =
  STORYBOARD_NODE_CONTENT_WIDTH - STORYBOARD_PANEL_DIVIDER_WIDTH
export const STORYBOARD_SCRIPT_PANEL_WIDTH = Math.round(
  (STORYBOARD_SCRIPT_MODE_PANEL_AREA_WIDTH * STORYBOARD_SCRIPT_PANEL_RATIO) /
    (STORYBOARD_SCRIPT_PANEL_RATIO + STORYBOARD_PREVIEW_PANEL_RATIO),
)
export const STORYBOARD_PREVIEW_HEIGHT = 541
export const STORYBOARD_SCREEN_MODE_PREVIEW_PANEL_WIDTH = 1115
export const STORYBOARD_SCRIPT_MODE_PREVIEW_PANEL_WIDTH =
  STORYBOARD_SCRIPT_MODE_PANEL_AREA_WIDTH - STORYBOARD_SCRIPT_PANEL_WIDTH
export const STORYBOARD_PREVIEW_WIDTH = 960
export const STORYBOARD_PREVIEW_SIDE_GUTTER_TOTAL =
  STORYBOARD_SCREEN_MODE_PREVIEW_PANEL_WIDTH - STORYBOARD_PREVIEW_WIDTH
export const STORYBOARD_SCRIPT_MODE_PREVIEW_WIDTH =
  STORYBOARD_SCRIPT_MODE_PREVIEW_PANEL_WIDTH - STORYBOARD_PREVIEW_SIDE_GUTTER_TOTAL
export const STORYBOARD_SCRIPT_MODE_PREVIEW_HEIGHT = Math.round(
  (STORYBOARD_SCRIPT_MODE_PREVIEW_WIDTH * STORYBOARD_PREVIEW_HEIGHT) / STORYBOARD_PREVIEW_WIDTH,
)
export const STORYBOARD_SHOT_IMAGE_FILE_ACCEPT =
  'image/jpeg,image/jpg,image/png,image/webp,.jpeg,.jpg,.png,.webp'
export const STORYBOARD_PLAYER_FRAME_RATE = 24
export const STORYBOARD_PLAYER_FRAME_STEP_SECONDS = 1 / STORYBOARD_PLAYER_FRAME_RATE
export const STORYBOARD_PLAYER_CONTROLS_HEIGHT = 83
export const STORYBOARD_PLAYER_PLAY_BUTTON_SIZE = 52
export const STORYBOARD_PLAYER_PLAY_ICON_SIZE = 30
export const STORYBOARD_PLAYER_TIME_DIVIDER_HEIGHT = 23
export const STORYBOARD_PLAYER_TIME_DIVIDER_MARGIN_X = 11
export const STORYBOARD_PLAYER_TIME_FONT_SIZE = 23
export const STORYBOARD_PLAYER_TIME_GAP = 19
export const STORYBOARD_TIMELINE_HEIGHT = 115
export const STORYBOARD_TIMELINE_PLAYHEAD_KNOB_SIZE = 13
export const STORYBOARD_TIMELINE_PLAYHEAD_TOP_OFFSET = 16
export const STORYBOARD_TIMELINE_SEGMENT_HEIGHT = 57
export const STORYBOARD_TIMELINE_SEGMENT_GAP = 1
export const STORYBOARD_TIMELINE_EDGE_GUTTER = 43
export const STORYBOARD_TIMELINE_TOP_GUTTER = 20
export const STORYBOARD_TIMELINE_VIEWPORT_WIDTH = 1029
export const STORYBOARD_TIMELINE_VIEWPORT_SIDE_PADDING_TOTAL =
  STORYBOARD_SCREEN_MODE_PREVIEW_PANEL_WIDTH - STORYBOARD_TIMELINE_VIEWPORT_WIDTH
export const STORYBOARD_SCREEN_MODE_PREVIEW_METRICS = {
  panelWidth: STORYBOARD_SCREEN_MODE_PREVIEW_PANEL_WIDTH,
  previewHeight: STORYBOARD_PREVIEW_HEIGHT,
  previewWidth: STORYBOARD_PREVIEW_WIDTH,
  timelineViewportWidth: STORYBOARD_TIMELINE_VIEWPORT_WIDTH,
} as const satisfies StoryboardWorkbenchPreviewPanelMetrics
export const STORYBOARD_SCRIPT_MODE_PREVIEW_METRICS = {
  panelWidth: STORYBOARD_SCRIPT_MODE_PREVIEW_PANEL_WIDTH,
  previewHeight: STORYBOARD_SCRIPT_MODE_PREVIEW_HEIGHT,
  previewWidth: STORYBOARD_SCRIPT_MODE_PREVIEW_WIDTH,
  timelineViewportWidth:
    STORYBOARD_SCRIPT_MODE_PREVIEW_PANEL_WIDTH - STORYBOARD_TIMELINE_VIEWPORT_SIDE_PADDING_TOTAL,
} as const satisfies StoryboardWorkbenchPreviewPanelMetrics
/* 节点颜色一律来自 base.css 的 --storyboard-node-* token（v13 上收到 :root），JS 侧只保留 var() 引用 */
export const STORYBOARD_NODE_SURFACE_STYLE = {
  backgroundColor: 'var(--storyboard-node-surface)',
} as const satisfies CSSProperties
export const PREVIEW_TOOL_ITEMS = [
  {
    id: 'music',
    label: '上传背景音',
  },
  {
    id: 'elements',
    label: '旁白',
  },
] as const satisfies readonly {
  id: 'elements' | 'music'
  label: string
}[]
export const PREVIEW_EXPORT_ACTION_ITEMS = [
  {
    disabled: false,
    id: 'all',
    label: '导出全部',
  },
  {
    disabled: true,
    id: 'merged',
    label: '导出成片，暂不可用',
  },
] as const satisfies readonly {
  disabled: boolean
  id: StoryboardWorkbenchExportAction
  label: string
}[]
export const SCREEN_TOOL_ITEMS = [
  {
    disabled: false,
    id: 'redo',
    label: '重做镜头素材',
  },
  {
    disabled: true,
    id: 'split',
    label: '剪切镜头素材，暂不可用',
  },
  {
    disabled: false,
    id: 'download',
    label: '下载镜头素材',
  },
] as const satisfies readonly {
  disabled: boolean
  id: StoryboardScreenToolIconType
  label: string
}[]
