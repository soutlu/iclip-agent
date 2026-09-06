import { http, HttpResponse } from 'msw'
import { beforeEach, describe, expect, it } from 'vitest'
import { server } from '@/testing/mocks/server'
import { uploadMediaFile } from './media-upload'

describe('uploadMediaFile 视频', () => {
  const assetId = 'f40a7a4b-90ec-438b-8bf0-9bde53a290fc'
  const uploadUrl = `http://localhost/mock-oss/${assetId}`
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
          assetId,
          upload: {
            expiresAt: '2026-09-06T12:00:00Z',
            headers: { 'Content-Type': 'video/mp4' },
            url: uploadUrl,
          },
        })
      }),
      http.put(uploadUrl, () => new HttpResponse(null, { status: 200 })),
      http.post('*/api/assets/:assetId', () =>
        HttpResponse.json({
          asset: {
            assetType: 'video',
            contentType: 'video/mp4',
            createdAt: '2026-09-06T10:00:00Z',
            creatorUserId: '427f8cd9-8016-4f54-a581-812447e97fdc',
            id: assetId,
            sizeBytes: 5,
            url: assetUrl,
          },
        }),
      ),
    )
  })

  it.each([
    ['video/mp4', 5],
    ['video/quicktime', 512 * 1024 * 1024],
  ])('上传 %s 后登记并返回永久地址，尺寸保留空值', async (type, size) => {
    await expect(uploadMediaFile(videoFile(type, size), 'video')).resolves.toBe(assetUrl)
    expect(signedBody).toEqual({ contentType: type, height: null, width: null })
    expect(requests).toEqual([
      'POST /api/uploads/sign',
      `PUT /mock-oss/${assetId}`,
      `POST /api/assets/${assetId}`,
    ])
  })

  it.each([
    ['video/webm', 5],
    ['image/png', 5],
    ['', 5],
    ['video/mp4', 512 * 1024 * 1024 + 1],
  ])('不上传不支持的类型或过大的视频：%s / %i 字节', async (type, size) => {
    await expect(uploadMediaFile(videoFile(type, size), 'video')).rejects.toThrow()
    expect(requests).toEqual([])
  })
})
