import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { use, useEffect } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkbenchLayoutContext } from '@/shared/workbench/workbench-layout-context'
import { Route as ShellRoute } from './_shell'

/** 路由插槽只报告面板可见，真实壳负责计算宽度及安装拖柄。 */
function LayoutPanel() {
  const layout = use(WorkbenchLayoutContext)
  const onPanelVisible = layout?.onPanelVisible
  useEffect(() => {
    onPanelVisible?.(true)
    return () => onPanelVisible?.(false)
  }, [onPanelVisible])
  return <section aria-label={layout?.sideBySide ? '并排面板' : '覆盖面板'} />
}

const renderShell = async (viewport: number) => {
  vi.stubGlobal('innerWidth', viewport)
  const matchMedia = window.matchMedia
  vi.stubGlobal('matchMedia', (query: string) => ({
    ...matchMedia(query),
    matches: query === '(min-width: 600px)' && viewport >= 600,
  }))
  const root = createRootRoute()
  const component = ShellRoute.options.component
  if (component === undefined) throw new Error('AppShell 路由缺少组件')
  const shell = createRoute({
    getParentRoute: () => root,
    id: '_shell',
    component,
    validateSearch: ShellRoute.options.validateSearch,
  })
  const page = createRoute({
    getParentRoute: () => shell,
    path: '/',
    component: () => <p>聊天区</p>,
    staticData: { rightPanel: LayoutPanel },
  })
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ['/'] }),
    routeTree: root.addChildren([shell.addChildren([page])]),
  })
  await router.load()
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  await screen.findByText('聊天区')
}

const workbenchWidth = () => screen.getByText('聊天区').closest('[style]')?.getAttribute('style')

afterEach(() => {
  vi.unstubAllGlobals()
  window.localStorage.clear()
})

describe('AppShell 列宽边界', () => {
  it('1335px 视口包含两个4px拖柄，当前宽度、拖动上限和持久化一致', async () => {
    await renderShell(1335)
    const handle = screen.getByRole('button', { name: '调整面板宽度' })
    expect(workbenchWidth()).toContain('--layout-app-workbench-width: 663px')
    expect(handle).toHaveAttribute('title', expect.stringContaining('560–663'))
    expect(handle).toHaveStyle({ width: '4px' })
    expect(screen.getByRole('button', { name: '调整侧栏宽度' })).toHaveStyle({ width: '4px' })

    fireEvent.pointerDown(handle, { button: 0, clientX: 700 })
    fireEvent.pointerMove(window, { clientX: 600 })
    fireEvent.pointerUp(window)

    expect(workbenchWidth()).toContain('--layout-app-workbench-width: 663px')
    expect(window.localStorage.getItem('cue.layout.workbench-width')).toBe('663')
  })

  it.each([
    [1231, '覆盖面板'],
    [1232, '并排面板'],
  ])('展开侧栏时视口 %i 使用%s', async (viewport, name) => {
    await renderShell(viewport)
    expect(screen.getByRole('region', { name })).toBeVisible()
    if (name === '覆盖面板') {
      expect(screen.queryByRole('button', { name: '调整面板宽度' })).not.toBeInTheDocument()
    } else {
      expect(workbenchWidth()).toContain('--layout-app-workbench-width: 560px')
    }
  })

  it.each([
    [963, '覆盖面板'],
    [964, '并排面板'],
  ])('折叠侧栏后视口 %i 只预留右侧拖柄，使用%s', async (viewport, name) => {
    await renderShell(viewport)
    await userEvent.click(screen.getByRole('button', { name: '折叠侧边栏' }))

    expect(screen.getByRole('region', { name })).toBeVisible()
    expect(screen.queryByRole('button', { name: '调整侧栏宽度' })).not.toBeInTheDocument()
    if (name === '并排面板') {
      expect(workbenchWidth()).toContain('--layout-app-workbench-width: 560px')
      expect(screen.getByRole('button', { name: '调整面板宽度' })).toHaveAttribute(
        'title',
        expect.stringContaining('560–560'),
      )
    }
  })

  it('宽视口仍保持默认820px面板', async () => {
    await renderShell(1600)
    expect(workbenchWidth()).toContain('--layout-app-workbench-width: 820px')
  })
})
