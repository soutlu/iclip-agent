import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import { makeGenerationJob } from '@/testing/generation-job'
import type { GenerationJob } from '../storyboard.api'
import { ConversationVideos } from './conversation-videos'

const conversationId = 'ff2c1c0e-6c4f-4f0e-9a2b-0f2f3a4b5c6d'

const job = (index: number, overrides: Partial<GenerationJob> = {}): GenerationJob =>
  makeGenerationJob({
    id: `a82db548-d093-4f54-b71b-${index.toString(16).padStart(12, '0')}`,
    createdAt: '2026-09-01T10:00:00Z',
    outputUrl: `https://videos.example.test/take-${index}.mp4`,
    metadata: { shot: 1 },
    ...overrides,
  })

beforeEach(() => {
  vi.stubGlobal('scrollTo', () => {})
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('ConversationVideos', () => {
  it('读完分页后展示旧页中的成片，不把第一页没有成功结果误报为空', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) =>
      job(1000 - index, { status: 'failed', outputUrl: null }),
    )
    const requests: URLSearchParams[] = []
    server.use(
      http.get('*/api/generations', ({ request }) => {
        const params = new URL(request.url).searchParams
        requests.push(params)
        return HttpResponse.json({ items: params.has('before') ? [job(1)] : firstPage })
      }),
    )

    await renderWithProviders(<ConversationVideos conversationId={conversationId} />)

    expect(await screen.findByLabelText('镜头组 1视频')).toHaveAttribute('src', job(1).outputUrl)
    expect(requests.map((params) => Object.fromEntries(params))).toEqual([
      { conversationId, kind: 'video', limit: '100' },
      { conversationId, kind: 'video', limit: '100', before: firstPage.at(-1)?.id },
    ])
    expect(screen.queryByRole('group', { name: '镜头组 1版本' })).not.toBeInTheDocument()
    expect(screen.queryByText('暂无视频产物')).not.toBeInTheDocument()
  })

  it('默认播放最新成功版本，切换与放大暂停旧播放器，关闭预览后归还焦点', async () => {
    const pause = vi.mocked(HTMLMediaElement.prototype.pause)
    server.use(http.get('*/api/generations', () => HttpResponse.json({ items: [job(1), job(2)] })))
    await renderWithProviders(<ConversationVideos conversationId={conversationId} />)

    const initial = await screen.findByLabelText('镜头组 1视频')
    expect(initial).toHaveAttribute('src', job(2).outputUrl)
    expect(screen.getByRole('button', { name: '镜头组 1 V2' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await userEvent.click(screen.getByRole('button', { name: '镜头组 1 V1' }))
    expect(pause).toHaveBeenCalledOnce()
    expect(initial).not.toBeInTheDocument()
    const selected = screen.getByLabelText('镜头组 1视频')
    expect(selected).toHaveAttribute('src', job(1).outputUrl)
    expect(screen.getByRole('button', { name: '镜头组 1 V1' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )

    vi.spyOn(selected as HTMLVideoElement, 'paused', 'get').mockReturnValue(false)
    const enlarge = screen.getByRole('button', { name: '放大镜头组 1' })
    await userEvent.click(enlarge)
    expect(pause).toHaveBeenCalledTimes(2)
    const dialog = await screen.findByRole('dialog', { name: '镜头组 1' })
    expect(within(dialog).getByLabelText('镜头组 1')).toHaveAttribute('src', job(1).outputUrl)
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await waitFor(() => expect(enlarge).toHaveFocus())
  })

  it('播放另一个镜头组时暂停当前正在播放的视频', async () => {
    const pause = vi.mocked(HTMLMediaElement.prototype.pause)
    server.use(
      http.get('*/api/generations', () =>
        HttpResponse.json({ items: [job(1), job(2, { metadata: { shot: 2 } })] }),
      ),
    )
    await renderWithProviders(<ConversationVideos conversationId={conversationId} />)
    const first = await screen.findByLabelText('镜头组 1视频')
    vi.spyOn(first as HTMLVideoElement, 'paused', 'get').mockReturnValue(false)

    fireEvent.play(screen.getByLabelText('镜头组 2视频'))

    expect(pause).toHaveBeenCalledOnce()
    expect(pause.mock.instances[0]).toBe(first)
  })

  it('媒体加载失败有重试入口，重试重新加载原地址，切版不保留上一版的错误', async () => {
    const load = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
    server.use(http.get('*/api/generations', () => HttpResponse.json({ items: [job(1), job(2)] })))
    await renderWithProviders(<ConversationVideos conversationId={conversationId} />)
    const video = await screen.findByLabelText('镜头组 1视频')

    fireEvent.error(video)

    expect(screen.getByRole('alert')).toBeVisible()
    expect(video).not.toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(load).toHaveBeenCalledOnce()
    expect(load.mock.instances[0]).toBe(video)
    expect(video).toHaveAttribute('src', job(2).outputUrl)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    fireEvent.error(video)
    await userEvent.click(screen.getByRole('button', { name: '镜头组 1 V1' }))
    expect(screen.getByLabelText('镜头组 1视频')).toBeVisible()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('有在途记录时每五秒兜底发现新结果并默认选择最新版本，全部结束后停止轮询', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    let reads = 0
    server.use(
      http.get('*/api/generations', () => {
        reads += 1
        return HttpResponse.json({
          items:
            reads === 1
              ? [job(1), job(2, { status: 'submitted', outputUrl: null })]
              : [job(1), job(2)],
        })
      }),
    )
    await renderWithProviders(<ConversationVideos conversationId={conversationId} />)
    expect(await screen.findByLabelText('镜头组 1视频')).toHaveAttribute('src', job(1).outputUrl)

    await act(() => vi.advanceTimersByTime(5000))

    await screen.findByRole('button', { name: '镜头组 1 V2' })
    expect(screen.getByLabelText('镜头组 1视频')).toHaveAttribute('src', job(2).outputUrl)
    expect(reads).toBe(2)
    await act(() => vi.advanceTimersByTime(5000))
    expect(reads).toBe(2)
  })

  it('列表全部结束时不轮询', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    let reads = 0
    server.use(
      http.get('*/api/generations', () => {
        reads += 1
        return HttpResponse.json({ items: [job(1)] })
      }),
    )
    await renderWithProviders(<ConversationVideos conversationId={conversationId} />)
    await screen.findByLabelText('镜头组 1视频')

    await act(() => vi.advanceTimersByTime(5000))

    expect(reads).toBe(1)
  })

  it('只认本对话的生成帧：别的对话的帧不重拉，本对话的帧立刻重拉并展示新成片', async () => {
    let reads = 0
    server.use(
      http.get('*/api/generations', () => {
        reads += 1
        return HttpResponse.json({ items: reads === 1 ? [job(1)] : [job(1), job(2)] })
      }),
    )
    const { socket } = await renderWithProviders(
      <ConversationVideos conversationId={conversationId} />,
    )
    await screen.findByLabelText('镜头组 1视频')
    const changed = (sessionId: string) => ({
      type: 'event.generation.changed',
      session_id: sessionId,
      payload: { id: job(2).id, kind: 'video', status: 'completed', metadata: { shot: 1 } },
    })

    act(() => socket.deliver(changed('0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d')))
    // 留出一次真实请求往返的时间，否则「没重拉」是空断言。
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
    expect(reads).toBe(1)

    act(() => socket.deliver(changed(conversationId)))

    await screen.findByRole('button', { name: '镜头组 1 V2' })
    expect(screen.getByLabelText('镜头组 1视频')).toHaveAttribute('src', job(2).outputUrl)
    expect(reads).toBe(2)
  })

  it('读取失败明确提示并可重试，重试成功后展示视频', async () => {
    let reads = 0
    server.use(
      http.get('*/api/generations', () => {
        reads += 1
        return reads === 1
          ? HttpResponse.json({ detail: '服务暂不可用' }, { status: 503 })
          : HttpResponse.json({ items: [job(1)] })
      }),
    )
    await renderWithProviders(<ConversationVideos conversationId={conversationId} />)

    expect(await screen.findByRole('alert')).toHaveTextContent('服务暂不可用')
    expect(screen.queryByText('暂无视频产物')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '重试' }))

    expect(await screen.findByLabelText('镜头组 1视频')).toBeVisible()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(reads).toBe(2)
  })

  it('刷新失败时保留可播放结果并显示错误，刷新成功后保留手选版本', async () => {
    let reads = 0
    server.use(
      http.get('*/api/generations', () => {
        reads += 1
        if (reads === 2) return HttpResponse.json({ detail: '刷新中断' }, { status: 503 })
        return HttpResponse.json({
          items: reads === 1 ? [job(1), job(2)] : [job(1), job(2), job(3)],
        })
      }),
    )
    const { queryClient } = await renderWithProviders(
      <ConversationVideos conversationId={conversationId} />,
    )
    await screen.findByLabelText('镜头组 1视频')
    await userEvent.click(screen.getByRole('button', { name: '镜头组 1 V1' }))
    await queryClient.invalidateQueries({ queryKey: ['generations'] })

    expect(await screen.findByRole('alert')).toHaveTextContent('刷新中断')
    expect(screen.getByLabelText('镜头组 1视频')).toHaveAttribute('src', job(1).outputUrl)
    await userEvent.click(screen.getByRole('button', { name: '重试' }))
    await screen.findByRole('button', { name: '镜头组 1 V3' })
    expect(screen.getByLabelText('镜头组 1视频')).toHaveAttribute('src', job(1).outputUrl)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('没有成片时只显示紧凑空态', async () => {
    server.use(http.get('*/api/generations', () => HttpResponse.json({ items: [] })))

    await renderWithProviders(<ConversationVideos conversationId={conversationId} />)

    expect(await screen.findByText('暂无视频产物')).toBeVisible()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})
