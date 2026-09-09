import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { server } from '@/testing/mocks/server'
import type { Shot } from './shot-document'
import {
  generationsRefetchInterval,
  historyShotOf,
  submitVideoGeneration,
  uploadFrameImage,
  videoShotOf,
  type GenerationJob,
} from './storyboard.api'

const conversationId = 'ff2c1c0e-6c4f-4f0e-9a2b-0f2f3a4b5c6d'

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
  it('照上游形状发到视频端点：镜头组结构化发出、参考图取整组，回执只取任务号', async () => {
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
      seconds: 6,
      shot: {
        global_settings: '人物保持一致。',
        timeline: [
          { image_indexes: [1, 2], prompt: '走向镜头 @Image1，停下 @Image2。', seconds: 6 },
        ],
      },
      shot_index: 2,
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

describe('videoShotOf', () => {
  it('起止秒改成每镜时长，间隙不算进去，保留到毫秒', () => {
    const gapped: Shot = {
      ...shot,
      prompt: {
        global_settings: '设定。',
        timeline: [
          { timestamps: [0, 3.5], prompt: '一。', image_indexes: [] },
          { timestamps: [4.25, 8.5], prompt: '二 @Image1。', image_indexes: [1] },
          { timestamps: [8.5, 8.6], prompt: '三。', image_indexes: [] },
        ],
      },
    }
    expect(videoShotOf(gapped)).toEqual({
      global_settings: '设定。',
      timeline: [
        { image_indexes: [], prompt: '一。', seconds: 3.5 },
        { image_indexes: [1], prompt: '二 @Image1。', seconds: 4.25 },
        { image_indexes: [], prompt: '三。', seconds: 0.1 },
      ],
    })
  })
})

describe('historyShotOf', () => {
  const job = (request: Record<string, unknown>): GenerationJob => ({
    createdAt: '2026-09-01T10:00:00Z',
    errorMessage: null,
    id: 'e5b1c0de-6c1e-4f1a-9b3d-8c0a1f2e3d40',
    kind: 'video',
    outputUrl: null,
    request,
    shotIndex: 2,
    status: 'completed',
    taskId: null,
    watermarkOutputUrl: null,
  })

  it('时长首尾相接算回起止秒，浮点尾数按毫秒收掉', () => {
    expect(
      historyShotOf(
        job({
          prompt: '拼好的正文',
          shot: {
            global_settings: '设定。',
            timeline: [
              { image_indexes: [], prompt: '一。', seconds: 0.1 },
              { image_indexes: [1], prompt: '二 @Image1。', seconds: 0.2 },
              { image_indexes: [], prompt: '三。', seconds: 0.3 },
            ],
          },
        }),
      ),
    ).toEqual({
      global_settings: '设定。',
      timeline: [
        { timestamps: [0, 0.1], prompt: '一。', image_indexes: [] },
        { timestamps: [0.1, 0.3], prompt: '二 @Image1。', image_indexes: [1] },
        { timestamps: [0.3, 0.6], prompt: '三。', image_indexes: [] },
      ],
    })
  })

  it.each([
    ['只有正文', { prompt: '模特走向镜头，停下微笑。' }],
    ['shot 为空', { prompt: '正文', shot: null }],
    ['shot 缺时间线', { prompt: '正文', shot: { global_settings: '设定。', timeline: [] } }],
    [
      '时长不是正数',
      {
        shot: {
          global_settings: '设定。',
          timeline: [{ image_indexes: [], prompt: '一。', seconds: 0 }],
        },
      },
    ],
  ])('%s 的记录回填不了', (_name, request) => {
    expect(historyShotOf(job(request))).toBeUndefined()
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

describe('uploadFrameImage', () => {
  const assetId = 'f40a7a4b-90ec-438b-8bf0-9bde53a290fc'
  const uploadUrl = `http://localhost/mock-oss/${assetId}`
  const assetUrl = 'https://assets.example.com/replacement.png'
  const requests: string[] = []
  const decode = vi.fn<typeof createImageBitmap>()
  const close = vi.fn()
  let signedBody: unknown

  const imageFile = (type = 'image/png', size = 4) =>
    new File([new Uint8Array(size)], '本地图片.png', { type })

  beforeEach(() => {
    requests.length = 0
    signedBody = undefined
    close.mockReset()
    decode.mockReset().mockResolvedValue({ close, height: 1200, width: 800 })
    vi.stubGlobal('createImageBitmap', decode)
    server.events.on('request:start', ({ request }) => {
      requests.push(`${request.method} ${new URL(request.url).pathname}`)
    })
    server.use(
      http.post('*/api/uploads/sign', async ({ request }) => {
        signedBody = await request.json()
        return HttpResponse.json({
          assetId,
          upload: {
            expiresAt: '2026-09-06T12:00:00Z',
            headers: { 'Content-Type': 'image/png', 'x-upload-token': 'test-ticket' },
            url: uploadUrl,
          },
        })
      }),
      http.put(uploadUrl, ({ request }) => {
        expect(request.headers.get('Content-Type')).toBe('image/png')
        expect(request.headers.get('x-upload-token')).toBe('test-ticket')
        return new HttpResponse(null, { status: 200 })
      }),
      http.post('*/api/assets/:assetId', () =>
        HttpResponse.json({
          asset: {
            assetType: 'image',
            contentType: 'image/png',
            createdAt: '2026-09-06T10:00:00Z',
            creatorUserId: '427f8cd9-8016-4f54-a581-812447e97fdc',
            id: assetId,
            sizeBytes: 4,
            url: assetUrl,
          },
        }),
      ),
    )
  })

  afterEach(() => vi.unstubAllGlobals())

  it.each([
    ['image/jpeg', 300, 6000, 4],
    ['image/png', 6000, 300, 16 * 1024 * 1024],
    ['image/webp', 800, 1200, 4],
  ])('用解码尺寸签名，直传后才登记 %s 图片', async (type, width, height, size) => {
    decode.mockResolvedValue({ close, height, width })
    const file = imageFile(type, size)

    await expect(uploadFrameImage(file)).resolves.toBe(assetUrl)

    expect(decode).toHaveBeenCalledWith(file)
    expect(close).toHaveBeenCalledOnce()
    expect(signedBody).toEqual({ contentType: type, height, width })
    expect(requests).toEqual([
      'POST /api/uploads/sign',
      `PUT /mock-oss/${assetId}`,
      `POST /api/assets/${assetId}`,
    ])
  })

  it.each([
    ['image/gif', 4],
    ['text/plain', 4],
    ['', 4],
    ['image/png', 16 * 1024 * 1024 + 1],
  ])('类型或大小不合规时不解码、不上传：%s / %i 字节', async (type, size) => {
    await expect(uploadFrameImage(imageFile(type, size))).rejects.toThrow()
    expect(decode).not.toHaveBeenCalled()
    expect(requests).toEqual([])
  })

  it('图片解码失败时保留错误，不请求上传签名', async () => {
    decode.mockRejectedValue(new DOMException('Invalid image', 'InvalidStateError'))

    await expect(uploadFrameImage(imageFile())).rejects.toThrow('无法读取图片')
    expect(requests).toEqual([])
  })

  it.each([
    [299, 1200],
    [800, 299],
    [6001, 300],
    [300, 6001],
  ])('图片尺寸 %i × %i 不合规时释放解码资源，不请求签名', async (width, height) => {
    decode.mockResolvedValue({ close, height, width })

    await expect(uploadFrameImage(imageFile())).rejects.toThrow('图片短边至少')
    expect(close).toHaveBeenCalledOnce()
    expect(requests).toEqual([])
  })

  it('签名失败时停止上传，返回后端错误', async () => {
    server.use(
      http.post('*/api/uploads/sign', () =>
        HttpResponse.json({ detail: '签名服务不可用' }, { status: 503 }),
      ),
    )

    await expect(uploadFrameImage(imageFile())).rejects.toThrow('签名服务不可用')
    expect(requests).toEqual(['POST /api/uploads/sign'])
  })

  it('OSS 上传失败时不登记素材', async () => {
    server.use(http.put(uploadUrl, () => new HttpResponse(null, { status: 503 })))

    await expect(uploadFrameImage(imageFile())).rejects.toThrow('上传失败：503')
    expect(requests).toEqual(['POST /api/uploads/sign', `PUT /mock-oss/${assetId}`])
  })

  it('素材登记失败时不返回上传地址', async () => {
    server.use(
      http.post('*/api/assets/:assetId', () =>
        HttpResponse.json({ detail: '图片登记失败' }, { status: 422 }),
      ),
    )

    await expect(uploadFrameImage(imageFile())).rejects.toThrow('图片登记失败')
    expect(requests).toEqual([
      'POST /api/uploads/sign',
      `PUT /mock-oss/${assetId}`,
      `POST /api/assets/${assetId}`,
    ])
  })
})
