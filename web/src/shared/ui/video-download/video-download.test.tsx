import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Toaster, toast } from '@/shared/ui/toast'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import { VideoDownload } from './video-download'

const JOB_ID = '0b9c2f4e-5d8a-4c1b-9e3f-7a6d5c4b3a21'
const CLEAN = 'https://downloads.example.test/clean.mp4'
const MARKED = 'https://downloads.example.test/marked.mp4'

/** 下载边界：外链照常回字节，Blob URL 与锚点点击换成桩，点击即视为交给浏览器保存。 */
const stubSaving = () => {
  const fetched: string[] = []
  server.use(
    http.get('https://downloads.example.test/*', ({ request }) => {
      fetched.push(request.url)
      return new HttpResponse(new Uint8Array([1, 2, 3]), {
        headers: { 'Content-Type': 'video/mp4' },
      })
    }),
  )
  vi.stubGlobal(
    'URL',
    class extends URL {
      static override createObjectURL = () => 'blob:http://localhost/video'
      static override revokeObjectURL() {}
    },
  )
  const saved = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  return { fetched, saved }
}

beforeEach(() => {
  vi.stubGlobal('scrollTo', () => {})
})

afterEach(() => {
  toast.dismiss()
  vi.unstubAllGlobals()
})

describe('VideoDownload', () => {
  it.each([
    { entry: '只有原片时直接点下载', item: null, url: CLEAN, watermarkUrl: null },
    { entry: '选「下载原片」', item: '下载原片', url: CLEAN, watermarkUrl: MARKED },
    { entry: '选「下载水印版」', item: '下载水印版', url: MARKED, watermarkUrl: MARKED },
  ])(
    '$entry：带 jobId 记一条下载事件，不等它回来就取字节保存',
    async ({ item, url, watermarkUrl }) => {
      const { fetched, saved } = stubSaving()
      const events: unknown[] = []
      let release: () => void = () => undefined
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      server.use(
        http.post('*/api/tracking/events', async ({ request }) => {
          events.push(await request.json())
          await gate
          return new HttpResponse(null, { status: 204 })
        }),
      )
      const user = userEvent.setup()
      await renderWithProviders(
        <VideoDownload jobId={JOB_ID} url={CLEAN} watermarkUrl={watermarkUrl} />,
      )

      await user.click(screen.getByRole('button', { name: '下载视频' }))
      if (item !== null) await user.click(await screen.findByRole('menuitem', { name: item }))

      await waitFor(() => expect(events).toEqual([{ jobId: JOB_ID, name: 'video.downloaded' }]))
      // 事件还悬着，字节已经取回并交给浏览器。
      await waitFor(() => expect(saved).toHaveBeenCalledTimes(1))
      expect(fetched).toEqual([url])
      release()
    },
  )

  it('事件接口失败时下载照常完成，不弹提示，只在控制台留一条警告', async () => {
    const { fetched, saved } = stubSaving()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    server.use(
      http.post('*/api/tracking/events', () =>
        HttpResponse.json({ detail: '埋点暂时不可用' }, { status: 500 }),
      ),
    )
    await renderWithProviders(
      <>
        <Toaster />
        <VideoDownload jobId={JOB_ID} url={CLEAN} watermarkUrl={null} />
      </>,
    )

    await userEvent.click(screen.getByRole('button', { name: '下载视频' }))

    await waitFor(() => expect(saved).toHaveBeenCalledTimes(1))
    expect(fetched).toEqual([CLEAN])
    await waitFor(() => expect(warn).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByRole('button', { name: '下载视频' })).toBeEnabled())
    const notifications = screen.getByRole('region', { name: /Notifications/ })
    expect(within(notifications).queryAllByRole('listitem')).toHaveLength(0)
  })
})
