import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { createElement, type ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import { makeGenerationJob } from '@/testing/generation-job'
import { server } from '@/testing/mocks/server'
import { generationsRefetchInterval } from '../storyboard.api'
import {
  compileEditPrompt,
  imageEditConversationKey,
  imageEditJobsRefetchInterval,
  imageEditQueryKey,
  parseEditPrompt,
  resolveImageOptions,
  seedImageEditJob,
  submitImageEdit,
  useFrameImageJobs,
} from './image-edit.api'
import type { ImageModel } from './image-edit.api'
import type { FrameEditDraft, FrameEditTarget } from './image-edit-types'

const draft = (): FrameEditDraft => ({
  annotations: [
    { id: 'a1', number: 1, kind: 'ellipse', points: [{ x: 0.3, y: 0.4 }] },
    { id: 'a2', number: 2, kind: 'point', points: [{ x: 0.5, y: 0.5 }] },
  ],
  instructions: [
    { kind: 'text', text: '把' },
    { kind: 'annotation', id: 'a1' },
    { kind: 'text', text: '的杯子换成红色，参考' },
    { kind: 'referenceImage', id: 'r3' },
    { kind: 'text', text: '的材质。' },
  ],
  references: [
    { id: 'r1', kind: 'image', url: 'https://cdn.test/frame.png', label: '编辑底图' },
    { id: 'r2', kind: 'annotated', url: 'https://cdn.test/annotated.png', label: '当前标注图' },
    { id: 'r3', kind: 'image', url: 'https://cdn.test/jacket.png', label: 'jacket.png' },
  ],
})

describe('compileEditPrompt', () => {
  it('把芯片落成 @ 标记，编号取图片在本次提交里的位置', () => {
    expect(compileEditPrompt(draft())).toBe(
      '把@标注1的杯子换成红色，参考@图片3的材质。\n' +
        '图中的编号和圈选只表示位置，输出干净的图片，不保留标注。',
    )
  })

  it('没有标注图就不加那句收尾', () => {
    expect(
      compileEditPrompt({
        annotations: [],
        instructions: [{ kind: 'text', text: '换个背景' }],
        references: draft().references.filter((reference) => reference.kind !== 'annotated'),
      }),
    ).toBe('换个背景')
  })
})

describe('parseEditPrompt', () => {
  it('@图片N 装回芯片，收尾那句不留在正文里', () => {
    const original = draft()
    expect(parseEditPrompt(compileEditPrompt(original), original.references)).toEqual([
      { kind: 'text', text: '把@标注1的杯子换成红色，参考' },
      { kind: 'referenceImage', id: 'r3' },
      { kind: 'text', text: '的材质。' },
    ])
  })

  it('编号超出图片张数就当普通文字留着，不造出指向空处的芯片', () => {
    expect(parseEditPrompt('参考@图片9', draft().references)).toEqual([
      { kind: 'text', text: '参考@图片9' },
    ])
  })
})

const target: FrameEditTarget = {
  conversationId: 'ff2c1c0e-6c4f-4f0e-9a2b-0f2f3a4b5c6d',
  shotIndex: 2,
  frameNumber: 3,
}

describe('useFrameImageJobs', () => {
  it('帧状态只取调模型的图片记录：切图没有坐标，不占 100 条的窗口', async () => {
    let query: URLSearchParams | undefined
    server.use(
      http.get('*/api/generations', ({ request }) => {
        query = new URL(request.url).searchParams
        return HttpResponse.json({ items: [] })
      }),
    )
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { result } = renderHook(() => useFrameImageJobs(target.conversationId), {
      wrapper: ({ children }: { children: ReactNode }) =>
        createElement(QueryClientProvider, { client: queryClient }, children),
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(query?.get('kind')).toBe('image')
    expect(query?.get('operation')).toBe('generate')
  })
})

describe('imageEditJobsRefetchInterval', () => {
  const done = makeGenerationJob({ kind: 'image', status: 'completed' })
  const running = makeGenerationJob({ kind: 'image', status: 'submitted' })

  it('与生成列表同一口径：已翻开的哪一页里有在跑的都算', () => {
    const interval = imageEditJobsRefetchInterval({
      pages: [{ items: [done] }, { items: [running] }],
    })

    expect(interval).toBe(generationsRefetchInterval([done, running]))
    expect(interval).not.toBe(false)
  })

  it('全落定了、或者还没读到就不问', () => {
    expect(imageEditJobsRefetchInterval({ pages: [{ items: [done] }] })).toBe(false)
    expect(imageEditJobsRefetchInterval(undefined)).toBe(false)
  })
})

describe('seedImageEditJob', () => {
  const job = makeGenerationJob({ kind: 'image', status: 'pending' })

  it('这一格还没读过就落成一页', () => {
    const queryClient = new QueryClient()

    seedImageEditJob(queryClient, target, job)

    expect(queryClient.getQueryData(imageEditQueryKey(target))).toEqual({
      pages: [{ items: [job] }],
      pageParams: [undefined],
    })
  })

  it('已翻开几页时只进第一页最前面、同一条替换不重复，其余页不动，并失效本对话前缀', () => {
    const queryClient = new QueryClient()
    const older = makeGenerationJob({ kind: 'image' })
    const secondPage = { items: [makeGenerationJob({ kind: 'image' })] }
    queryClient.setQueryData(imageEditQueryKey(target), {
      pages: [{ items: [job, older] }, secondPage],
      pageParams: [undefined, older.id],
    })
    const frameJobsKey = imageEditConversationKey(target.conversationId)
    queryClient.setQueryData(frameJobsKey, { items: [] })
    const accepted = { ...job, status: 'submitted' as const }

    seedImageEditJob(queryClient, target, accepted)

    expect(queryClient.getQueryData(imageEditQueryKey(target))).toEqual({
      pages: [{ items: [accepted, older] }, secondPage],
      pageParams: [undefined, older.id],
    })
    expect(queryClient.getQueryState(frameJobsKey)?.isInvalidated).toBe(true)
  })
})

describe('submitImageEdit', () => {
  it('改的是哪张图走 sourceUrl，坐标只记这一格，参考图照发', async () => {
    let body: Record<string, unknown> = {}
    server.use(
      http.post('*/api/generations/image', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>
        return HttpResponse.json(
          {
            generation: {
              createdAt: '2026-09-13T02:00:00Z',
              errorMessage: null,
              id: '4a1e2f60-9a1e-4c2f-9c8b-1d2e3f4a5b6c',
              kind: 'image',
              operation: 'generate',
              metadata: body['metadata'],
              outputUrl: null,
              request: {},
              status: 'pending',
              taskId: null,
              rootJobId: null,
              sourceUrl: body['sourceUrl'],
              clipStage: null,
              durationMs: null,
              watermarkOutputUrl: null,
            },
          },
          { status: 202 },
        )
      }),
    )

    const job = await submitImageEdit(target, draft(), 'https://cdn.test/frame.png', {
      aspectRatio: '9:16',
      model: 'nano_banana_pro',
      resolution: '2k',
      channel: 'dev',
    })

    expect(job.status).toBe('pending')
    expect(body['sourceUrl']).toBe('https://cdn.test/frame.png')
    expect(body['metadata']).toEqual({ shot: 2, frame: 3 })
    expect(body['referenceImageUrls']).toEqual([
      'https://cdn.test/frame.png',
      'https://cdn.test/annotated.png',
      'https://cdn.test/jacket.png',
    ])
  })
})

const NANO: ImageModel = {
  model: 'nano_banana_pro',
  label: 'Nano Banana Pro',
  aspectRatios: ['1:1', '4:5', '9:16'],
  resolutions: ['1k', '2k', '4k'],
  channels: ['dev', 'pro'],
}
const SEEDREAM: ImageModel = {
  model: 'seedream_v5_pro',
  label: 'Seedream 5.0 Pro',
  aspectRatios: ['1:1', '9:16'],
  resolutions: ['1k', '2k'],
  channels: [],
}
const WANTED = { model: 'nano_banana_pro', channel: 'dev', resolution: '2k' } as const

describe('resolveImageOptions', () => {
  it('保留调用方想要的那一组', () => {
    const resolved = resolveImageOptions([NANO, SEEDREAM], '9:16', WANTED)
    expect(resolved.model?.model).toBe('nano_banana_pro')
    expect(resolved.resolution).toBe('2k')
    expect(resolved.channel).toBe('dev')
  })

  it('所选模型没有渠道这个轴时不给渠道', () => {
    const resolved = resolveImageOptions([NANO, SEEDREAM], '9:16', {
      ...WANTED,
      model: 'seedream_v5_pro',
    })
    expect(resolved.channel).toBeUndefined()
  })

  it('档位落在所选模型范围外时退到它最高的一档', () => {
    const resolved = resolveImageOptions([NANO, SEEDREAM], '9:16', {
      ...WANTED,
      model: 'seedream_v5_pro',
      resolution: '4k',
    })
    expect(resolved.resolution).toBe('2k')
  })

  it('画幅这家出不了就换成出得了的那家', () => {
    const resolved = resolveImageOptions([SEEDREAM, NANO], '4:5', {
      ...WANTED,
      model: 'seedream_v5_pro',
    })
    expect(resolved.model?.model).toBe('nano_banana_pro')
    expect(resolved.aspectUnsupported).toBe(false)
  })

  it('一家都出不了这个画幅时报出来，而不是挑一家去撞 422', () => {
    const resolved = resolveImageOptions([SEEDREAM], '4:5', WANTED)
    expect(resolved.model).toBeUndefined()
    expect(resolved.aspectUnsupported).toBe(true)
  })

  it('模型还没加载完不算画幅不支持', () => {
    expect(resolveImageOptions([], '4:5', WANTED).aspectUnsupported).toBe(false)
  })
})
