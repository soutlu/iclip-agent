export const PROJECT_PAGE_LAYOUT = {
  composerWidth:
    'min(clamp(var(--layout-project-composer-min), var(--layout-project-composer-fluid), var(--layout-project-composer-max)), calc(100% - (var(--layout-project-stage-padding) * 2)))',
  desktopSidebarDefault: 420,
  desktopSidebarMax: 600,
  desktopSidebarMin: 400,
  mobileComposerHeights: {
    full: 90,
    minimized: 8,
    partial: 40,
  },
} as const

export type ProjectMobileComposerState = keyof typeof PROJECT_PAGE_LAYOUT.mobileComposerHeights
