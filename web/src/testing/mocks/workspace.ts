/**
 * 工作区与生成任务的 mock：一份内存文件表加几条生成任务。
 *
 * 文件表由 REST 读、由 WebSocket 那一侧改（`transcript.ts` 演 agent 改文件），两边共用这一份对象
 * ——分开放的话 `event.fs.changed` 到了、重读回来的还是旧内容。
 */

import { http, HttpResponse } from 'msw'

/** 镜头帧：本地 data URL，mock 环境离线也能渲染。 */
const FRAME_URLS = [
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='320'%3E%3Crect width='180' height='320' fill='%23e4ded2'/%3E%3Ccircle cx='90' cy='120' r='38' fill='%23a8742a'/%3E%3Crect x='60' y='170' width='60' height='110' fill='%236b5330'/%3E%3C/svg%3E",
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='320'%3E%3Crect width='180' height='320' fill='%23d3dee4'/%3E%3Cpolygon points='90,70 150,250 30,250' fill='%232a5f8a'/%3E%3C/svg%3E",
]

/** 出片占位：只有 ftyp 盒的 mp4，够 `<video>` 收下这个地址而不去打外网。 */
const VIDEO_URL = 'data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDE='

const SHOT_TWO_PROMPT = '硬切，她从长椅间走向镜头 @Image1，走到近处停下微笑 @Image2。'

/** agent 改过之后第 2 组的样子。e2e 靠这句话判「重读到新内容了」。 */
const SHOT_TWO_PROMPT_AFTER = `${SHOT_TWO_PROMPT.slice(0, -1)}，台词并成一句。`

export const SHOTS_MOCK_PATH = 'video_shot.json'

const shotsDocument = (secondPrompt: string) => ({
  aspectRatio: '9:16',
  shots: [
    {
      imageUrls: [FRAME_URLS[0]],
      index: 1,
      prompt: '开场，模特提着帆布包走出门厅 @Image1，抬头看向前方。',
      seconds: 6,
    },
    { imageUrls: FRAME_URLS, index: 2, prompt: secondPrompt, seconds: 11 },
    {
      imageUrls: [FRAME_URLS[1]],
      index: 3,
      prompt: '低角度拍鞋面 @Image1，鞋头包覆与魔术贴细节。',
      seconds: 4,
    },
  ],
})

type MockFile = { content: string; updatedAt: string; version: number }

/** 每段对话的工作区：路径 → 文件。 */
const workspaces = new Map<string, Map<string, MockFile>>()

/** 每段对话的生成任务。 */
const generations = new Map<string, unknown[]>()

/**
 * 给一段对话种上一份三组的 `video_shot.json`，外加第 3 组一条出好的视频。
 *
 * @param conversationId - 哪一段对话。
 */
export const seedMockWorkspace = (conversationId: string) => {
  const now = new Date().toISOString()
  workspaces.set(
    conversationId,
    new Map([
      [
        SHOTS_MOCK_PATH,
        {
          content: JSON.stringify(shotsDocument(SHOT_TWO_PROMPT), null, 2),
          updatedAt: now,
          version: 1,
        },
      ],
    ]),
  )
  generations.set(conversationId, [
    {
      conversationId,
      createdAt: '2026-09-01T10:00:00Z',
      errorCode: null,
      errorMessage: null,
      finishedAt: '2026-09-01T10:04:00Z',
      id: '4a1e2f60-9a1e-4c2f-9c8b-1d2e3f4a5b6c',
      kind: 'video',
      outputUrl: VIDEO_URL,
      provider: 'mock',
      providerStatus: 'succeeded',
      request: {},
      shotIndex: 3,
      status: 'completed',
      submittedAt: '2026-09-01T10:00:10Z',
      updatedAt: '2026-09-01T10:04:00Z',
    },
  ])
}

/**
 * 演一次 agent 改文件：第 2 组的台词并成一句，版本加一。
 *
 * @param conversationId - 哪一段对话。
 * @returns 改动落下了没有；这段对话没种过文件就是没有。
 */
export const touchMockShots = (conversationId: string): boolean => {
  const files = workspaces.get(conversationId)
  const file = files?.get(SHOTS_MOCK_PATH)
  if (files === undefined || file === undefined) return false
  files.set(SHOTS_MOCK_PATH, {
    content: JSON.stringify(shotsDocument(SHOT_TWO_PROMPT_AFTER), null, 2),
    updatedAt: new Date().toISOString(),
    version: file.version + 1,
  })
  return true
}

export const resetMockWorkspace = () => {
  workspaces.clear()
  generations.clear()
}

export const workspaceHandlers = [
  http.get('*/api/conversations/:conversationId/workspace/files', ({ params }) => {
    const files = workspaces.get(String(params['conversationId'])) ?? new Map<string, MockFile>()
    return HttpResponse.json({
      files: [...files].map(([path, file]) => ({
        path,
        sizeBytes: file.content.length,
        updatedAt: file.updatedAt,
        version: file.version,
      })),
    })
  }),

  http.get('*/api/conversations/:conversationId/workspace/file', ({ params, request }) => {
    const path = new URL(request.url).searchParams.get('path') ?? ''
    const file = workspaces.get(String(params['conversationId']))?.get(path)
    if (file === undefined) return HttpResponse.json({ detail: '文件不存在' }, { status: 404 })
    return HttpResponse.json({ file: { content: file.content, path, version: file.version } })
  }),

  http.get('*/api/generations', ({ request }) => {
    const conversationId = new URL(request.url).searchParams.get('conversationId')
    const items = conversationId === null ? [] : (generations.get(conversationId) ?? [])
    return HttpResponse.json({ items })
  }),
]
