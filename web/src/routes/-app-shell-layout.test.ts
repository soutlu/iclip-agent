import { describe, expect, it } from 'vitest'
import { resolveShellLayout } from './-app-shell-layout'

const layoutAt = (viewport: number, sidebarCollapsed = false) =>
  resolveShellLayout({ viewport, sidebarCollapsed, sidebarWidth: 264, workbenchWidth: 820 })

describe('应用壳列宽', () => {
  it('1335px 视口为聊天和两条拖柄留位，面板上限为 663px', () => {
    expect(layoutAt(1335)).toEqual({
      compact: false,
      sideBySide: true,
      sidebarWidth: 264,
      workbenchMax: 663,
      workbenchWidth: 663,
    })
  })

  it.each([
    { viewport: 1231, sidebarCollapsed: false, sideBySide: false },
    { viewport: 1232, sidebarCollapsed: false, sideBySide: true },
    { viewport: 963, sidebarCollapsed: true, sideBySide: false },
    { viewport: 964, sidebarCollapsed: true, sideBySide: true },
  ])('视口 $viewport、侧栏折叠 $sidebarCollapsed 时并排为 $sideBySide', (input) => {
    expect(layoutAt(input.viewport, input.sidebarCollapsed)).toMatchObject({
      sideBySide: input.sideBySide,
      workbenchWidth: 560,
    })
  })

  it('空间充足时保留默认宽度，不自动填满剩余空间', () => {
    expect(layoutAt(1600)).toMatchObject({ workbenchMax: 928, workbenchWidth: 820 })
  })

  it.each([
    { sidebarWidth: 150, workbenchWidth: 400, sidebar: 200, workbench: 560 },
    { sidebarWidth: 500, workbenchWidth: 900, sidebar: 400, workbench: 792 },
    { sidebarWidth: 320, workbenchWidth: 700, sidebar: 320, workbench: 700 },
  ])('用户宽度 $sidebarWidth/$workbenchWidth 受最小尺寸和可用空间约束', (input) => {
    expect(
      resolveShellLayout({
        viewport: 1600,
        sidebarCollapsed: false,
        sidebarWidth: input.sidebarWidth,
        workbenchWidth: input.workbenchWidth,
      }),
    ).toMatchObject({ sidebarWidth: input.sidebar, workbenchWidth: input.workbench })
  })

  it.each([
    { viewport: 599, compact: true },
    { viewport: 600, compact: false },
  ])('视口 $viewport 的紧凑模式为 $compact', ({ viewport, compact }) => {
    expect(layoutAt(viewport)).toMatchObject({ compact, sideBySide: false })
  })
})
