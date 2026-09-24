import { QueryClient } from '@tanstack/react-query'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { makeGenerationJob } from '@/testing/generation-job'
import { server } from '@/testing/mocks/server'
import { imageEditConversationKey, imageEditQueryKey } from './image-edit/image-edit.api'
import type { Shot } from './shot-document'
import {
  generationsRefetchInterval,
  historyShotOf,
  readConversationVideoJobs,
  storyboardQueryKeys,
  submitVideoGeneration,
  type GenerationJob,
} from './storyboard.api'
import { videoEditChainKey } from './video-editor/video-editor.api'

const conversationId = 'ff2c1c0e-6c4f-4f0e-9a2b-0f2f3a4b5c6d'

describe('storyboardQueryKeys', () => {
  it('本对话的生成记录查询都在 conversation 前缀下，模型清单与别的对话不在', async () => {
    const keys = {
      videoJobs: storyboardQueryKeys.videoJobs(conversationId),
      frameJobs: imageEditConversationKey(conversationId),
      frameCell: imageEditQueryKey({ conversationId, frameNumber: 1, shotIndex: 1 }),
      editChain: videoEditChainKey(conversationId, 'root-job'),
      otherConversation: storyboardQueryKeys.videoJobs('a4b5c6d7-1111-4f0e-9a2b-0f2f3a4b5c6d'),
      imageModels: storyboardQueryKeys.imageModels,
      videoModels: storyboardQueryKeys.videoModels,
    }
    const queryClient = new QueryClient()
    for (const key of Object.values(keys)) queryClient.setQueryData(key, {})

    await queryClient.invalidateQueries({
      queryKey: storyboardQueryKeys.conversation(conversationId),
    })

    const invalidated = Object.entries(keys)
      .filter(([, key]) => queryClient.getQueryState(key)?.isInvalidated)
      .map(([name]) => name)
    expect(invalidated).toEqual(['videoJobs', 'frameJobs', 'frameCell', 'editChain'])
  })
})

/** 与 server/tests/helpers/generation.py 的 video_shot 是同一份夹具；服务端拼出的正文见那边的 SHOT_PROMPT。 */
const shot: Shot = {
  index: 2,
  seconds: 6,
  image_urls: ['https://example.com/a.png', 'https://example.com/b.png'],
  prompt: {
    global_settings: '人物保持一致。',
    timeline: [
      { timestamps: [0, 6], prompt: '走向镜头 @Image1，停下 @Image2。', image_indexes: [1, 2] },
    ],
  },
}

describe('submitVideoGeneration', () => {
  it('照上游形状发到视频端点：镜头组按分镜文件的形状原样发出、参考图取整组，回执只取任务号', async () => {
    let body: unknown
    server.use(
      http.post('*/api/generations/video', async ({ request }) => {
        body = await request.json()
        return HttpResponse.json(
          { task_id: '4a1e2f60-9a1e-4c2f-9c8b-1d2e3f4a5b6c' },
          { status: 202 },
        )
      }),
    )

    await expect(
      submitVideoGeneration({
        aspectRatio: '9:16',
        conversationId,
        generateAudio: false,
        model: 'wan3.0-video',
        shot,
      }),
    ).resolves.toBe('4a1e2f60-9a1e-4c2f-9c8b-1d2e3f4a5b6c')

    expect(body).toEqual({
      aspect_ratio: '9:16',
      conversation_id: conversationId,
      generate_audio: false,
      model: 'wan3.0-video',
      reference_image_urls: shot.image_urls,
      resolution: '720p',
      seconds: 6,
      shot: {
        global_settings: '人物保持一致。',
        timeline: [
          { image_indexes: [1, 2], prompt: '走向镜头 @Image1，停下 @Image2。', timestamps: [0, 6] },
        ],
      },
      metadata: { shot: 2 },
    })
  })

  it('服务端拒收时把 detail 原话抛出来', async () => {
    server.use(
      http.post('*/api/generations/video', () =>
        HttpResponse.json({ detail: '视频生成仅支持模型 moyu-seedance-2-5' }, { status: 422 }),
      ),
    )

    await expect(
      submitVideoGeneration({
        aspectRatio: '9:16',
        conversationId,
        generateAudio: true,
        model: 'x',
        shot,
      }),
    ).rejects.toThrow('视频生成仅支持模型 moyu-seedance-2-5')
  })
})

describe('historyShotOf', () => {
  const job = (request: Record<string, unknown>): GenerationJob =>
    makeGenerationJob({
      createdAt: '2026-09-01T10:00:00Z',
      id: 'e5b1c0de-6c1e-4f1a-9b3d-8c0a1f2e3d40',
      metadata: { shot: 2 },
      request,
    })

  it('记录里的 shot 与分镜文件的 prompt 同形，起止秒与间隙原样取回', () => {
    const history = {
      global_settings: '设定。',
      timeline: [
        { timestamps: [0, 3.5], prompt: '一。', image_indexes: [] },
        { timestamps: [4.25, 8.5], prompt: '二 @Image1。', image_indexes: [1] },
      ],
    }
    expect(historyShotOf(job({ prompt: '拼好的正文', shot: history }))).toEqual(history)
  })

  it.each([
    ['只有正文', { prompt: '模特走向镜头，停下微笑。' }],
    ['shot 为空', { prompt: '正文', shot: null }],
    ['shot 缺时间线', { prompt: '正文', shot: { global_settings: '设定。', timeline: [] } }],
    [
      'timestamps 不是一对秒数',
      {
        shot: {
          global_settings: '设定。',
          timeline: [{ image_indexes: [], prompt: '一。', timestamps: [3] }],
        },
      },
    ],
  ])('%s 的记录回填不了', (_name, request) => {
    expect(historyShotOf(job(request))).toBeUndefined()
  })
})

describe('readConversationVideoJobs', () => {
  const fullPage = () => Array.from({ length: 100 }, () => makeGenerationJob())

  it('按上一页最后一条往前翻，直到空页，按页序拼起全部记录', async () => {
    const pages = [fullPage(), fullPage(), []]
    const requests: Record<string, string>[] = []
    server.use(
      http.get('*/api/generations', ({ request }) => {
        requests.push(Object.fromEntries(new URL(request.url).searchParams))
        return HttpResponse.json({ items: pages[requests.length - 1] })
      }),
    )

    const jobs = await readConversationVideoJobs(conversationId, new AbortController().signal)

    expect(jobs.map((job) => job.id)).toEqual(pages.flat().map((job) => job.id))
    expect(requests).toEqual([
      { conversationId, kind: 'video', limit: '100' },
      { conversationId, kind: 'video', limit: '100', before: pages[0]?.at(-1)?.id },
      { conversationId, kind: 'video', limit: '100', before: pages[1]?.at(-1)?.id },
    ])
  })

  it('游标原地不动时报分页异常，不无限翻页', async () => {
    const page = fullPage()
    let reads = 0
    server.use(
      http.get('*/api/generations', () => {
        reads += 1
        return HttpResponse.json({ items: page })
      }),
    )

    await expect(
      readConversationVideoJobs(conversationId, new AbortController().signal),
    ).rejects.toThrow('读取视频记录失败：分页异常，请重试')
    expect(reads).toBe(2)
  })
})

describe('generationsRefetchInterval', () => {
  it('有任务还在飞就定时再问一次', () => {
    expect(generationsRefetchInterval([{ status: 'completed' }, { status: 'submitted' }])).toBe(
      5000,
    )
    expect(generationsRefetchInterval([{ status: 'pending' }])).toBe(5000)
  })

  it('全落定了、或者一条都没有就不问', () => {
    expect(generationsRefetchInterval([{ status: 'completed' }, { status: 'failed' }])).toBe(false)
    expect(generationsRefetchInterval([])).toBe(false)
  })
})
