/**
 * 工作区与生成任务的 mock：一份内存文件表加几条生成任务。
 *
 * 文件表由 REST 读、由 WebSocket 那一侧改（`transcript.ts` 演 agent 改文件），两边共用这一份对象
 * ——分开放的话 `event.fs.changed` 到了、重读回来的还是旧内容。
 */

import { http, HttpResponse } from 'msw'

/** 镜头帧：本地 data URL，mock 环境离线也能渲染。 */
const FRAME_A =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='320'%3E%3Crect width='180' height='320' fill='%23e4ded2'/%3E%3Ccircle cx='90' cy='120' r='38' fill='%23a8742a'/%3E%3Crect x='60' y='170' width='60' height='110' fill='%236b5330'/%3E%3C/svg%3E"
const FRAME_B =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='320'%3E%3Crect width='180' height='320' fill='%23d3dee4'/%3E%3Cpolygon points='90,70 150,250 30,250' fill='%232a5f8a'/%3E%3C/svg%3E"

/** 出片占位：只有 ftyp 盒的 mp4，够 `<video>` 收下这个地址而不去打外网。 */
const VIDEO_URL = 'data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDE='

/** 前言那两行：界面里折叠在描述顶部，默认收起。 */
const PREAMBLE = ['参考锁定：模特的服装与发型跟住 @Image1。', '剪辑形式：硬切。'].join('\n')

/** 第 2 组有两个镜头，其中镜头 2 用了两张帧——三栏与底部缩略图都靠它才有东西可看。 */
const SHOT_TWO_PROMPT = [
  PREAMBLE,
  '',
  '[0–4秒｜镜头1]',
  '她从长椅间走向镜头 @Image1，脚步放慢。',
  '',
  '[4–11秒｜镜头2]',
  '走到近处停下微笑 @Image2，再低头看一眼包 @Image3。',
].join('\n')

/** agent 改过之后第 2 组的样子。e2e 靠这句话判「重读到新内容了」。 */
const SHOT_TWO_PROMPT_AFTER = SHOT_TWO_PROMPT.replace(
  '再低头看一眼包 @Image3。',
  '再低头看一眼包 @Image3，台词并成一句。',
)

export const SHOTS_MOCK_PATH = 'video_shot.json'

const shotsDocument = (secondPrompt: string) => ({
  aspectRatio: '9:16',
  shots: [
    {
      imageUrls: [FRAME_A],
      index: 1,
      prompt: ['[0–6秒｜镜头1]', '开场，模特提着帆布包走出门厅 @Image1，抬头看向前方。'].join('\n'),
      seconds: 6,
    },
    { imageUrls: [FRAME_A, FRAME_B, FRAME_A], index: 2, prompt: secondPrompt, seconds: 11 },
    {
      imageUrls: [FRAME_B],
      index: 3,
      prompt: ['[0–4秒｜镜头1]', '低角度拍鞋面 @Image1，鞋头包覆与魔术贴细节。'].join('\n'),
      seconds: 4,
    },
  ],
})

type MockFile = { content: string; updatedAt: string; version: number }

type MockJob = {
  createdAt: string
  errorMessage?: string
  id: string
  kind?: 'video' | 'image'
  outputUrl?: string
  prompt: string
  shotIndex?: number
  status: 'completed' | 'failed' | 'submitted'
}

/** 补齐 GenerationOut 的必填字段，用例只写自己关心的那几项。 */
const job = (spec: MockJob) => ({
  conversationId: null as string | null,
  createdAt: spec.createdAt,
  errorCode: spec.status === 'failed' ? 'provider_empty' : null,
  errorMessage: spec.errorMessage ?? null,
  finishedAt: spec.status === 'submitted' ? null : spec.createdAt,
  id: spec.id,
  kind: spec.kind ?? 'video',
  outputUrl: spec.outputUrl ?? null,
  provider: 'mock',
  providerStatus: spec.status,
  request: { prompt: spec.prompt },
  shotIndex: spec.shotIndex ?? null,
  status: spec.status,
  submittedAt: spec.createdAt,
  updatedAt: spec.createdAt,
})

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
    job({
      createdAt: '2026-09-01T10:04:00Z',
      id: '4a1e2f60-9a1e-4c2f-9c8b-1d2e3f4a5b6c',
      outputUrl: VIDEO_URL,
      prompt: '模特走向镜头，停下微笑，暖光。',
      shotIndex: 3,
      status: 'completed',
    }),
    job({
      createdAt: '2026-09-01T11:10:00Z',
      id: '5b2f3071-0b2f-4d30-8d9c-2e3f4a5b6c7d',
      outputUrl: VIDEO_URL,
      prompt: '第 2 组第一版：走向镜头后停下。',
      shotIndex: 2,
      status: 'completed',
    }),
    job({
      createdAt: '2026-09-01T11:40:00Z',
      errorMessage: '上游返回了空结果，换个描述再试一次。',
      id: '6c304182-1c30-4e41-9eab-3f4a5b6c7d8e',
      prompt: '第 2 组第二版：加一个低头看包的动作。',
      shotIndex: 2,
      status: 'failed',
    }),
    job({
      createdAt: '2026-09-01T12:20:00Z',
      id: '7d415293-2d41-4f52-afbc-4a5b6c7d8e9f',
      prompt: '第 2 组第三版：脚步放慢，收尾停在微笑上。',
      shotIndex: 2,
      status: 'submitted',
    }),
    job({
      createdAt: '2026-09-01T09:30:00Z',
      id: '8e5263a4-3e52-4063-b0cd-5b6c7d8e9fa0',
      kind: 'image',
      outputUrl: FRAME_A,
      prompt: '出镜头帧：门厅全景，模特提包。',
      status: 'completed',
    }),
    job({
      createdAt: '2026-09-01T09:35:00Z',
      id: '9f6374b5-4f63-4174-91de-6c7d8e9fa0b1',
      kind: 'image',
      outputUrl: FRAME_B,
      prompt: '出镜头帧：近景微笑。',
      status: 'completed',
    }),
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
