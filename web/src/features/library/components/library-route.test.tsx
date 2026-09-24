import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockLibraryVideos } from '@/testing/mocks/library'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import { DEFAULT_LIBRARY_SCOPE, type LibraryScope } from '../library.api'
import { LibraryRoute } from './library-route'

/** 测试壳持有筛选范围，与路由把范围存在查询参数里的归属一致。 */
function Harness({ onScope }: { onScope?: (scope: LibraryScope) => void }) {
  const [scope, setScope] = useState(DEFAULT_LIBRARY_SCOPE)
  return (
    <LibraryRoute
      myUserName="tester"
      onScopeChange={(next) => {
        onScope?.(next)
        setScope(next)
      }}
      scope={scope}
    />
  )
}

/** 记下每次列表请求的查询串。 */
const recordListQueries = () => {
  const queries: URLSearchParams[] = []
  server.events.on('request:start', ({ request }) => {
    const url = new URL(request.url)
    if (url.pathname.endsWith('/library/videos')) queries.push(url.searchParams)
  })
  return queries
}

const cardNames = () =>
  screen.getAllByRole('article').map((card) => card.getAttribute('aria-label'))

/** jsdom 没有排版，元素尺寸都是 0；给页面滚动容器一个视口大小，虚拟列表才会渲染视口里的卡片。 */
const stubScrollViewport = () => {
  const sizeOf = (element: HTMLElement, size: number) => (element.tagName === 'MAIN' ? size : 0)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return sizeOf(this, 900)
  })
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return sizeOf(this, 1200)
  })
}

describe('LibraryRoute', () => {
  beforeEach(stubScrollViewport)

  it('lists one card per shot with its badges and the total', async () => {
    await renderWithProviders(<Harness />)

    const skate = await screen.findByRole('article', { name: '滑板女孩 · 厚底靴街拍 · 镜头组 1' })
    expect(within(skate).getByText('6 版')).toBeVisible()
    expect(within(skate).getByText(/4 镜/)).toBeVisible()
    const beach = screen.getByRole('article', { name: '童鞋海边亲子 · 镜头组 1' })
    expect(within(beach).getByText('成片')).toBeVisible()
    expect(within(beach).getByText(/0:15/)).toBeVisible()
    // 没挂对话的纯文本出片没有镜数，只标时长
    const plain = screen.getByRole('article', { name: '接口提交' })
    expect(within(plain).queryByText(/镜$/)).not.toBeInTheDocument()
    expect(screen.getByText('共 7 条')).toBeVisible()
  })

  it('filters by orientation, by me and by a card author', async () => {
    const queries = recordListQueries()
    const onScope = vi.fn()
    const user = userEvent.setup()
    await renderWithProviders(<Harness onScope={onScope} />)
    await screen.findAllByRole('article')

    await user.click(screen.getByRole('radio', { name: '横版' }))
    await waitFor(() => expect(cardNames()).toEqual(['童鞋海边亲子 · 镜头组 1', '接口提交']))
    expect(queries.at(-1)?.get('orientation')).toBe('landscape')
    expect(screen.getByText('找到 2 条')).toBeVisible()

    await user.click(screen.getByRole('radio', { name: '全部' }))
    await user.click(screen.getByRole('radio', { name: '我出的' }))
    await waitFor(() => expect(queries.at(-1)?.get('userName')).toBe('tester'))
    expect(queries.at(-1)?.get('orientation')).toBeNull()

    await user.click(screen.getByRole('radio', { name: '全部' }))
    const sandals = await screen.findByRole('article', { name: '春夏凉鞋合集 · 镜头组 1' })
    await user.click(within(sandals).getByRole('button', { name: /Nina\.He/ }))
    expect(onScope).toHaveBeenLastCalledWith(expect.objectContaining({ userName: 'Nina.He' }))
    await waitFor(() =>
      expect(cardNames()).toEqual(['春夏凉鞋合集 · 镜头组 1', '春夏凉鞋合集 · 镜头组 2']),
    )
  })

  it('searches the scripts after typing stops', async () => {
    const queries = recordListQueries()
    const user = userEvent.setup()
    await renderWithProviders(<Harness />)
    await screen.findAllByRole('article')

    await user.type(screen.getByRole('textbox', { name: '搜索脚本' }), '滑板')

    await waitFor(() => expect(cardNames()).toEqual(['滑板女孩 · 厚底靴街拍 · 镜头组 1']))
    expect(queries.at(-1)?.get('q')).toBe('滑板')
    // 输入过程中不逐字请求
    expect(queries.filter((query) => query.has('q'))).toHaveLength(1)
  })

  it('copies the full prompt from a card', async () => {
    const user = userEvent.setup()
    await renderWithProviders(<Harness />)
    const card = await screen.findByRole('article', { name: '接口提交' })

    await user.click(within(card).getByRole('button', { name: '复制完整提示词' }))

    await expect(navigator.clipboard.readText()).resolves.toBe(
      '一条横版的纯文本描述，没有分镜结构。',
    )
    expect(within(card).getByRole('button', { name: '已复制完整提示词' })).toBeVisible()
  })

  it('pages with a cursor and says when nothing matches', async () => {
    const [first, second] = mockLibraryVideos()
    server.use(
      http.get('*/api/library/videos', ({ request }) => {
        const url = new URL(request.url)
        if (url.searchParams.get('q') === '没有的词')
          return HttpResponse.json({ items: [], nextCursor: null, total: 0 })
        return url.searchParams.get('cursor') === null
          ? HttpResponse.json({ items: [first], nextCursor: 'next', total: 2 })
          : HttpResponse.json({ items: [second], nextCursor: null, total: null })
      }),
    )
    const user = userEvent.setup()
    await renderWithProviders(<Harness />)

    await screen.findAllByRole('article')
    expect(screen.getByText('已显示 1 / 2')).toBeVisible()
    await user.click(screen.getByRole('button', { name: '加载更多' }))
    await waitFor(() => expect(screen.getAllByRole('article')).toHaveLength(2))
    expect(screen.queryByRole('button', { name: '加载更多' })).not.toBeInTheDocument()

    await user.type(screen.getByRole('textbox', { name: '搜索脚本' }), '没有的词')
    expect(await screen.findByText(/没有找到匹配的片子/)).toBeVisible()
  })

  it('shows a retryable error when the list fails', async () => {
    server.use(
      http.get('*/api/library/videos', () =>
        HttpResponse.json({ detail: '数据库不可用' }, { status: 500 }),
      ),
    )
    await renderWithProviders(<Harness />)

    expect(await screen.findByRole('alert')).toHaveTextContent('数据库不可用')
    expect(screen.getByRole('button', { name: '重新加载' })).toBeVisible()
  })
})
