import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeGenerationJob } from '@/testing/generation-job'
import { stubMediaDurations } from '@/testing/media'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import { VideoEditor } from './video-editor'

const CONVERSATION = 'conversation-1'
const ROOT_URL = 'https://example.com/root.mp4'
const EDITED_URL = 'https://example.com/edited.mp4'
const ROOT_ID = '0f6a2c9e-8d4b-4c1e-9a7f-3b5d6e8f1a2b'
const root = makeGenerationJob({ id: ROOT_ID, outputUrl: ROOT_URL, metadata: { shot: 1 } })

const renderEditor = () =>
  renderWithProviders(
    <VideoEditor
      conversationId={CONVERSATION}
      loading={false}
      onClose={() => {}}
      root={root}
      shotIndex={1}
    />,
  )

let restoreMedia = () => {}

afterEach(() => {
  restoreMedia()
  restoreMedia = () => {}
  vi.restoreAllMocks()
})

describe('VideoEditor', () => {
  it('模型默认取清单里的默认项；默认项不支持编辑就退到第一个支持的', async () => {
    await renderEditor()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '编辑模型' })).toHaveTextContent(
        'moyu-seedance-2-5',
      ),
    )
  })

  it('默认模型不在编辑名单里时用第一个能编辑的', async () => {
    server.use(
      http.get('*/api/generations/video-models', () =>
        HttpResponse.json({
          default: 'moyu-seedance-2-0',
          items: ['wan3.0-video', 'moyu-seedance-2-0', 'moyu-seedance-2-5'],
        }),
      ),
    )
    await renderEditor()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '编辑模型' })).toHaveTextContent('wan3.0-video'),
    )
  })

  it('模型清单读不到时给出重新加载入口，点了再拉一次', async () => {
    let requests = 0
    server.use(
      http.get('*/api/generations/video-models', () => {
        requests += 1
        return HttpResponse.json({ detail: '模型清单读不到' }, { status: 500 })
      }),
    )
    await renderEditor()

    expect(await screen.findByText(/模型清单读不到/)).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: '重新加载模型' }))

    await waitFor(() => expect(requests).toBe(2))
  })

  it('编辑结果读不出时长时说明合成为何按不下去', async () => {
    restoreMedia = stubMediaDurations({ [ROOT_URL]: 8, [EDITED_URL]: null })
    server.use(
      http.get('*/api/generations', () =>
        HttpResponse.json({
          items: [
            makeGenerationJob({
              outputUrl: EDITED_URL,
              rootJobId: ROOT_ID,
              sourceJobId: ROOT_ID,
              rangeStartMs: 2000,
              rangeEndMs: 4000,
              request: { prompt: '把背景换成海边' },
              createdAt: '2026-09-16T10:02:00Z',
            }),
          ],
        }),
      ),
    )
    await renderEditor()

    expect(
      await screen.findByText('读不到编辑结果的时长，无法合成；关掉编辑器重开可再试一次'),
    ).toBeVisible()
    expect(screen.getByRole('button', { name: '合成成片' })).toBeDisabled()
  })
})
