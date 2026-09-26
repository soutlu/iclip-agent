import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockLibraryVideos } from '@/testing/mocks/library'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import { DEFAULT_LIBRARY_SCOPE, type LibraryScope } from '../library.api'
import { LibraryRoute } from './library-route'

/** 测试壳持有筛选范围与打开着的详情，与路由把两者存在查询参数里的归属一致：改筛选时详情随之关掉。 */
function Harness({
  onScope,
  initialVideo = null,
}: {
  onScope?: (scope: LibraryScope) => void
  initialVideo?: string | null
}) {
  const [scope, setScope] = useState(DEFAULT_LIBRARY_SCOPE)
  const [videoId, setVideoId] = useState(initialVideo)
  return (
    <LibraryRoute
      myUserName="tester"
      onScopeChange={(next) => {
        onScope?.(next)
        setScope(next)
        setVideoId(null)
      }}
      onVideoChange={setVideoId}
      scope={scope}
      shareLinkOf={(id) => `https://iclip.test/library?video=${id}`}
      videoId={videoId}
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

const SKATE = '滑板女孩 · 厚底靴街拍'
const SANDALS = '春夏凉鞋合集'

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

  it('lists one card per storyboard with its badges and the total', async () => {
    await renderWithProviders(<Harness />)

    const skate = await screen.findByRole('article', { name: SKATE })
    expect(within(skate).getByText('6 版')).toBeVisible()
    expect(within(skate).getByText(/4 镜/)).toBeVisible()
    // 只有一个镜头组的卡不标组数
    expect(within(skate).queryByText(/组$/)).not.toBeInTheDocument()
    const beach = screen.getByRole('article', { name: '童鞋海边亲子' })
    expect(within(beach).getByText('合成')).toBeVisible()
    expect(within(beach).getByText('4 版')).toBeVisible()
    expect(within(beach).getByText(/0:15/)).toBeVisible()
    // 两个镜头组的版本合在一张卡上
    const sandals = screen.getByRole('article', { name: SANDALS })
    expect(within(sandals).getByText('2 组')).toBeVisible()
    expect(within(sandals).getByText('3 版')).toBeVisible()
    // 没挂对话的纯文本出片没有镜数，只标时长
    const plain = screen.getByRole('article', { name: '接口提交' })
    expect(within(plain).queryByText(/镜$/)).not.toBeInTheDocument()
    expect(screen.getByText('共 6 条')).toBeVisible()
  })

  it('filters by orientation, by me and by a card author', async () => {
    const queries = recordListQueries()
    const onScope = vi.fn()
    const user = userEvent.setup()
    await renderWithProviders(<Harness onScope={onScope} />)
    await screen.findAllByRole('article')

    await user.click(screen.getByRole('radio', { name: '横版' }))
    await waitFor(() => expect(cardNames()).toEqual(['童鞋海边亲子', '接口提交']))
    expect(queries.at(-1)?.get('orientation')).toBe('landscape')
    expect(screen.getByText('找到 2 条')).toBeVisible()

    await user.click(screen.getByRole('radio', { name: '全部' }))
    await user.click(screen.getByRole('radio', { name: '我出的' }))
    await waitFor(() => expect(queries.at(-1)?.get('userName')).toBe('tester'))
    expect(queries.at(-1)?.get('orientation')).toBeNull()

    await user.click(screen.getByRole('radio', { name: '全部' }))
    const sandals = await screen.findByRole('article', { name: SANDALS })
    await user.click(within(sandals).getByRole('button', { name: /Nina\.He/ }))
    expect(onScope).toHaveBeenLastCalledWith(expect.objectContaining({ userName: 'Nina.He' }))
    await waitFor(() => expect(cardNames()).toEqual([SANDALS]))
  })

  it('searches the scripts after typing stops', async () => {
    const queries = recordListQueries()
    const user = userEvent.setup()
    await renderWithProviders(<Harness />)
    await screen.findAllByRole('article')

    await user.type(screen.getByRole('textbox', { name: '搜索脚本' }), '滑板')

    await waitFor(() => expect(cardNames()).toEqual([SKATE]))
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

/** 从列表点开一张卡的详情。 */
const openCard = async (user: ReturnType<typeof userEvent.setup>, title: string) => {
  const card = await screen.findByRole('article', { name: title })
  await user.click(within(card).getByRole('button', { name: `查看详情：${title}` }))
  return screen.findByRole('dialog', { name: title })
}

const playerIn = (viewer: HTMLElement, title: string) =>
  within(viewer).getByLabelText<HTMLVideoElement>(title, { selector: 'video' })

describe('library viewer', () => {
  beforeEach(() => {
    stubScrollViewport()
    // jsdom 不播放媒体，play / pause 换成立即完成。
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
  })

  it('opens a card with every version of its shot group and seeks to a cut', async () => {
    const user = userEvent.setup()
    await renderWithProviders(<Harness />)

    const viewer = await openCard(user, SKATE)
    const versions = await within(viewer).findByRole('group', { name: '这个镜头组的版本' })
    expect(within(versions).getAllByRole('button')).toHaveLength(6)
    expect(within(versions).getByRole('button', { pressed: true })).toHaveTextContent('第 6 版')

    await user.click(within(viewer).getByRole('button', { name: '镜头 3，1.9 秒起' }))
    expect(playerIn(viewer, SKATE).currentTime).toBeCloseTo(1.95)
    await user.click(within(versions).getByRole('button', { name: /第 1 版/ }))
    await user.click(within(viewer).getByRole('tab', { name: '参数与来源' }))
    expect(within(viewer).getByText('第 1 版', { selector: 'dd' })).toBeVisible()
  })

  it('offers the source conversation only to readers who can open it', async () => {
    const user = userEvent.setup()
    const { router } = await renderWithProviders(<Harness />)
    const own = mockLibraryVideos().find((video) => video.canOpenConversation)

    let viewer = await openCard(user, '跑鞋手持展示')
    await user.click(within(viewer).getByRole('tab', { name: '参数与来源' }))
    expect(within(viewer).getByRole('link', { name: '跑鞋手持展示' })).toHaveAttribute(
      'href',
      `/c/${own?.conversationId}`,
    )
    await user.click(within(viewer).getByRole('button', { name: '更多操作' }))
    await user.click(await screen.findByRole('menuitem', { name: '复制链接' }))
    await expect(navigator.clipboard.readText()).resolves.toBe(
      `https://iclip.test/library?video=${own?.id}`,
    )
    await user.click(within(viewer).getByRole('button', { name: '更多操作' }))
    await user.click(await screen.findByRole('menuitem', { name: '打开来源对话' }))
    await waitFor(() => expect(router.state.location.pathname).toBe(`/c/${own?.conversationId}`))

    // 别人的卡同样带着对话 id，但读者打不开那段对话，就不给入口
    await user.keyboard('{Escape}')
    expect(mockLibraryVideos().find((video) => video.title === SANDALS)).toMatchObject({
      canOpenConversation: false,
      conversationId: expect.any(String),
    })
    viewer = await openCard(user, SANDALS)
    await user.click(within(viewer).getByRole('button', { name: '更多操作' }))
    expect(await screen.findAllByRole('menuitem')).toHaveLength(1)
    await user.keyboard('{Escape}')
    await user.click(within(viewer).getByRole('tab', { name: '参数与来源' }))
    expect(within(viewer).queryByText('来源对话')).not.toBeInTheDocument()
  })

  it('steps through loaded cards with the arrow keys and hands focus back on close', async () => {
    const user = userEvent.setup()
    await renderWithProviders(<Harness />)

    await openCard(user, SKATE)
    await user.keyboard('{ArrowRight}')
    const next = await screen.findByRole('dialog', { name: '童鞋海边亲子' })
    await user.keyboard('{Escape}')

    await waitFor(() => expect(next).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: '查看详情：童鞋海边亲子' })).toHaveFocus()
  })

  it('leaves the arrow keys to a reference image opened on top', async () => {
    const user = userEvent.setup()
    await renderWithProviders(<Harness />)

    const viewer = await openCard(user, '跑鞋手持展示')
    await user.click(within(viewer).getByRole('button', { name: '查看参考图 1' }))
    await screen.findByRole('dialog', { name: '参考图 1' })
    await user.keyboard('{ArrowRight}')

    expect(within(viewer).getByText('跑鞋手持展示', { selector: 'h2' })).toBeVisible()
    expect(screen.getByRole('dialog', { name: '参考图 1' })).toBeVisible()
  })

  it('filters by the author picked in the viewer and closes it', async () => {
    const onScope = vi.fn()
    const user = userEvent.setup()
    await renderWithProviders(<Harness onScope={onScope} />)

    const viewer = await openCard(user, SANDALS)
    await user.click(within(viewer).getByRole('button', { name: /^Nina\.He/ }))

    expect(onScope).toHaveBeenLastCalledWith(expect.objectContaining({ userName: 'Nina.He' }))
    await waitFor(() => expect(viewer).not.toBeInTheDocument())
  })

  it('switches to another shot group of the same card without leaving it', async () => {
    const user = userEvent.setup()
    await renderWithProviders(<Harness />)

    const viewer = await openCard(user, SANDALS)
    // 卡面在只有一版的镜头组 1 上，没有版本条可切
    const other = await within(viewer).findByRole('button', { name: /镜头组 2/ })
    expect(
      within(viewer).queryByRole('group', { name: '这个镜头组的版本' }),
    ).not.toBeInTheDocument()
    await user.click(other)

    const versions = await within(viewer).findByRole('group', { name: '这个镜头组的版本' })
    expect(within(versions).getAllByRole('button')).toHaveLength(2)
    expect(within(versions).getByRole('button', { pressed: true })).toHaveTextContent('第 2 版')
    expect(within(viewer).getByText('居家客厅，几何地毯与木柜；自然窗光。')).toBeVisible()
    // 组不是卡：还是这张卡的详情，其他镜头组换成了镜头组 1
    expect(screen.getByRole('dialog', { name: SANDALS })).toBe(viewer)
    expect(within(viewer).getByRole('button', { name: /镜头组 1/ })).toBeVisible()
  })

  it('opens a shared link outside the loaded list and says when the video is gone', async () => {
    server.use(
      http.get('*/api/library/videos', () =>
        HttpResponse.json({ items: [], nextCursor: null, total: 0 }),
      ),
    )
    const shared = mockLibraryVideos().find((video) => video.title === SKATE)
    await renderWithProviders(<Harness initialVideo={shared?.id ?? null} />)
    expect(await screen.findByRole('dialog', { name: SKATE })).toBeVisible()
    cleanup()

    await renderWithProviders(<Harness initialVideo="7a1c0000-0000-4000-8000-00000000ffff" />)
    const dialog = await screen.findByRole('dialog', { name: '资料库详情' })
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('资料库里没有这条视频')
    expect(within(dialog).getByRole('button', { name: '重试' })).toBeVisible()
  })
})

describe('library storyboard', () => {
  beforeEach(() => {
    stubScrollViewport()
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
    // 能悬停时卡片会挂预览视频，卸载时清地址要调 load。
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined)
  })

  it('opens as a bottom sheet on touch screens and starts the viewer at the picked cut', async () => {
    const user = userEvent.setup()
    await renderWithProviders(<Harness />)
    const card = await screen.findByRole('article', { name: SKATE })

    await user.click(within(card).getByRole('button', { name: '故事板：4 镜，0:06' }))
    const sheet = await screen.findByRole('dialog', { name: '故事板' })
    expect(within(sheet).getAllByRole('button', { name: /^镜头 \d/ })).toHaveLength(4)
    await user.click(within(sheet).getByRole('button', { name: '镜头 3，1.9 秒起，打开详情' }))

    const viewer = await screen.findByRole('dialog', { name: SKATE })
    expect(sheet).not.toBeInTheDocument()
    const player = playerIn(viewer, SKATE)
    fireEvent.loadedMetadata(player)
    expect(player.currentTime).toBeCloseTo(1.95)
  })

  it('shows on hover, follows the pointer across frames and keeps the wheel to itself', async () => {
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (query) => ({ matches: query.includes('(hover: hover)'), media: query }) as MediaQueryList,
    )
    const user = userEvent.setup()
    await renderWithProviders(<Harness />)
    const card = await screen.findByRole('article', { name: SKATE })

    await user.hover(within(card).getByRole('button', { name: '故事板：4 镜，0:06' }))
    const popover = await screen.findByRole('dialog', { name: '故事板' })
    expect(popover).toHaveTextContent('镜头 1')
    const third = within(popover).getByRole('button', { name: '镜头 3，1.9 秒起，打开详情' })
    await user.hover(third)
    expect(popover).toHaveTextContent(/镜头 3.*她把滑板竖抱在身前/)

    const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 120 })
    third.dispatchEvent(wheel)
    expect(wheel.defaultPrevented).toBe(true)

    await user.unhover(third)
    await waitFor(() => expect(popover).not.toBeInTheDocument())
  })
})
