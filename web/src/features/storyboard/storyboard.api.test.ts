import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { server } from '@/testing/mocks/server'
import { generationsRefetchInterval, uploadFrameImage } from './storyboard.api'

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
