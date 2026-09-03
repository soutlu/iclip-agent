/**
 * 宿主的几何与分派。
 *
 * 几何全看断点，而 jsdom 的 matchMedia 恒为不匹配（等于最窄那一档），所以每个用例都用
 * `withViewport` 说清楚自己跑在多宽的视口上。
 */

import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import type { ArtifactRendererProps } from './artifact'
import { ArtifactRegistry } from './registry'
import { WorkbenchHost } from './workbench-host'
import { WorkbenchRegistryProvider } from './workbench-registry-provider'

const CONVERSATION_ID = 'ff2c1c0e-6c4f-4f0e-9a2b-0f2f3a4b5c6d'

/** 两条假条目：分镜自动打开，笔记不自动打开。渲染器只把自己认出来。 */
const registryWithTwo = () => {
  const registry = new ArtifactRegistry()
  registry.register({
    autoOpen: true,
    component: ({ artifact }: ArtifactRendererProps) => <p>画着{artifact.title}</p>,
    match: { path: 'video_shot.json' },
    title: () => '分镜',
    type: 'storyboard',
  })
  registry.register({
    autoOpen: false,
    component: ({ artifact }: ArtifactRendererProps) => <p>画着{artifact.title}</p>,
    match: { path: 'notes.md' },
    title: () => '笔记',
    type: 'notes',
  })
  return registry
}

const serveFiles = (paths: string[]) => {
  server.use(
    http.get('*/api/conversations/:conversationId/workspace/files', () =>
      HttpResponse.json({
        files: paths.map((path) => ({
          path,
          sizeBytes: 10,
          updatedAt: '2026-09-01T10:00:00Z',
          version: 1,
        })),
      }),
    ),
  )
}

const renderHost = (registry = registryWithTwo()) =>
  renderWithProviders(
    <WorkbenchRegistryProvider registry={registry}>
      <WorkbenchHost conversationId={CONVERSATION_ID} />
    </WorkbenchRegistryProvider>,
  )

/**
 * 按给定视口宽度跑一段用例。jsdom 的 matchMedia 恒为不匹配，等于最窄的那一档，
 * 而宿主的三档几何全看断点，所以这里按 `min-width` 现算。
 */
const withViewport = async (width: number, run: () => Promise<void>) => {
  const original = window.matchMedia
  window.matchMedia = (query: string) => ({
    matches: width >= Number(/min-width:\s*(\d+)px/.exec(query)?.[1] ?? 0),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })
  try {
    await run()
  } finally {
    window.matchMedia = original
  }
}

/** 放得下并排。 */
const WIDE = 1600

/** 放不下并排，但不是紧凑屏：面板与聊天二选一。 */
const MEDIUM = 1000

describe('WorkbenchHost', () => {
  it('一件产物都没有的对话保持折叠，展开后是空态与一句解释', async () => {
    serveFiles([])
    await withViewport(WIDE, async () => {
      await renderHost()

      const expand = await screen.findByRole('button', { name: '展开右侧面板' })
      expect(screen.queryByText('还没有产物')).not.toBeInTheDocument()

      await userEvent.click(expand)

      expect(screen.getByText('还没有产物')).toBeVisible()
      expect(screen.getByText(/agent 交付分镜之后/)).toBeVisible()
    })
  })

  it('紧凑屏保持折叠，哪怕有产物', async () => {
    serveFiles(['video_shot.json'])
    await withViewport(500, async () => {
      await renderHost()

      expect(await screen.findByRole('button', { name: '展开右侧面板' })).toBeVisible()
      expect(screen.queryByText('画着分镜')).not.toBeInTheDocument()
    })
  })

  it('只有一件产物时不给切换器，直接画它', async () => {
    serveFiles(['video_shot.json'])
    await withViewport(WIDE, async () => {
      await renderHost()

      expect(await screen.findByText('画着分镜')).toBeVisible()
      expect(screen.getByRole('heading', { name: '分镜' })).toBeVisible()
      expect(screen.queryByRole('button', { name: '分镜' })).not.toBeInTheDocument()
    })
  })

  it('产物不止一件时给切换器，默认选 autoOpen 的那件', async () => {
    serveFiles(['notes.md', 'video_shot.json'])
    await withViewport(WIDE, async () => {
      await renderHost()

      // 文件列表里笔记在前，但自动打开的是分镜。
      expect(await screen.findByText('画着分镜')).toBeVisible()

      await userEvent.click(screen.getByRole('button', { name: '分镜' }))
      await userEvent.click(await screen.findByRole('menuitemradio', { name: '笔记' }))

      expect(await screen.findByText('画着笔记')).toBeVisible()
    })
  })

  it('放不下并排时是二选一形态：只给「回到聊天」，点了退回展开钮', async () => {
    serveFiles(['video_shot.json'])
    await withViewport(MEDIUM, async () => {
      await renderHost()

      expect(await screen.findByText('画着分镜')).toBeVisible()
      expect(screen.queryByRole('button', { name: '放大面板' })).not.toBeInTheDocument()

      await userEvent.click(screen.getByRole('button', { name: '回到聊天' }))

      expect(screen.getByRole('button', { name: '展开右侧面板' })).toBeVisible()
      expect(screen.queryByText('画着分镜')).not.toBeInTheDocument()
    })
  })

  it('放得下并排时给放大与折叠，放大之后钮换成缩小', async () => {
    serveFiles(['video_shot.json'])
    await withViewport(WIDE, async () => {
      await renderHost()

      expect(await screen.findByText('画着分镜')).toBeVisible()
      expect(screen.getByRole('button', { name: '折叠右侧面板' })).toBeVisible()

      await userEvent.click(screen.getByRole('button', { name: '放大面板' }))

      expect(screen.getByRole('button', { name: '缩小面板' })).toBeVisible()
      expect(screen.getByText('画着分镜')).toBeVisible()
    })
  })
})
