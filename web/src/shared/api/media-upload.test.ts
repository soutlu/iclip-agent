import { http, HttpResponse } from 'msw'
import { beforeEach, describe, expect, it } from 'vitest'
import { server } from '@/testing/mocks/server'
import { errorMessageOf, UserFacingError } from './client'
import { uploadMediaFile } from './media-upload'

const FALLBACK = '兜底文案'

const rejectionOf = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (reason: unknown) => reason,
  )

describe('uploadMediaFile 视频', () => {
  const uploadId = 'f40a7a4b-90ec-438b-8bf0-9bde53a290fc'
  const uploadUrl = `http://localhost/mock-oss/${uploadId}`
  const assetUrl = 'https://assets.example.com/reference.mp4'
  const requests: string[] = []
  let signedBody: unknown

  const videoFile = (type: string, size: number) => {
    const file = new File(['video'], '参考视频.mp4', { type })
    Object.defineProperty(file, 'size', { value: size })
    return file
  }

  beforeEach(() => {
    signedBody = undefined
    requests.length = 0
    server.events.on('request:start', ({ request }) => {
      requests.push(`${request.method} ${new URL(request.url).pathname}`)
    })
    server.use(
      http.post('*/api/uploads/sign', async ({ request }) => {
        signedBody = await request.json()
        return HttpResponse.json({
          uploadId,
          upload: {
            expiresAt: '2026-09-06T12:00:00Z',
            headers: { 'Content-Type': 'video/mp4' },
            url: uploadUrl,
          },
        })
      }),
      http.put(uploadUrl, () => new HttpResponse(null, { status: 200 })),
      http.post('*/api/uploads/:uploadId/confirm', () =>
        HttpResponse.json({ contentType: 'video/mp4', sizeBytes: 5, url: assetUrl }),
      ),
    )
  })

  it.each([
    ['video/mp4', 5],
    ['video/quicktime', 512 * 1024 * 1024],
  ])('上传 %s 后确认并返回永久地址，尺寸保留空值', async (type, size) => {
    await expect(uploadMediaFile(videoFile(type, size), 'video')).resolves.toBe(assetUrl)
    expect(signedBody).toEqual({ contentType: type, height: null, width: null })
    expect(requests).toEqual([
      'POST /api/uploads/sign',
      `PUT /mock-oss/${uploadId}`,
      `POST /api/uploads/${uploadId}/confirm`,
    ])
  })

  it.each([
    ['video/webm', 5],
    ['image/png', 5],
    ['', 5],
    ['video/mp4', 512 * 1024 * 1024 + 1],
  ])('不上传不支持的类型或过大的视频：%s / %i 字节，错误可直接展示', async (type, size) => {
    const error = await rejectionOf(uploadMediaFile(videoFile(type, size), 'video'))
    expect(error).toBeInstanceOf(UserFacingError)
    expect(errorMessageOf(error, FALLBACK)).not.toBe(FALLBACK)
    expect(requests).toEqual([])
  })

  it('给了 onProgress 时经直传回报进度，传完是 1', async () => {
    const ratios: number[] = []
    await expect(
      uploadMediaFile(videoFile('video/mp4', 5), 'video', {
        onProgress: (ratio) => ratios.push(ratio),
      }),
    ).resolves.toBe(assetUrl)
    expect(ratios.at(-1)).toBe(1)
  })

  it.each([
    ['对象存储拒绝', () => new HttpResponse(null, { status: 403 }), '上传失败（403）'],
    ['断网', () => HttpResponse.error(), '上传失败：网络连接失败，请检查网络后重试'],
  ])('直传失败（%s）给出与接口错误同格式的中文，不再确认', async (_case, respond, message) => {
    server.use(http.put(uploadUrl, respond))

    const error = await rejectionOf(uploadMediaFile(videoFile('video/mp4', 5), 'video'))

    expect(error).toBeInstanceOf(UserFacingError)
    expect(errorMessageOf(error, FALLBACK)).toBe(message)
    expect(requests).toEqual(['POST /api/uploads/sign', `PUT /mock-oss/${uploadId}`])
  })
})
