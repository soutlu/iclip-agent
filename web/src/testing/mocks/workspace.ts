/** REST 读取与 WebSocket 模拟写入共用内存文件表，确保通知后重读得到新内容。 */

import { http, HttpResponse } from 'msw'

/** 本地 data URL 帧，避免网络依赖。 */
const FRAME_A =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='320'%3E%3Crect width='180' height='320' fill='%23e4ded2'/%3E%3Ccircle cx='90' cy='120' r='38' fill='%23a8742a'/%3E%3Crect x='60' y='170' width='60' height='110' fill='%236b5330'/%3E%3C/svg%3E"
const FRAME_B =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='320'%3E%3Crect width='180' height='320' fill='%23d3dee4'/%3E%3Cpolygon points='90,70 150,250 30,250' fill='%232a5f8a'/%3E%3C/svg%3E"

const FRAME_C =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='320'%3E%3Crect width='180' height='320' fill='%23e8d9d1'/%3E%3Crect x='40' y='90' width='100' height='140' rx='12' fill='%238a4a2a'/%3E%3C/svg%3E"

/** 仅含 ftyp 盒的 MP4 占位地址，避免视频元素请求外网。 */
const VIDEO_URL = 'data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDE='

const PREAMBLE = ['参考锁定：模特的服装与发型跟住 @Image1。', '剪辑形式：硬切。'].join('\n')

const SHOT_TWO_PROMPT = [
  PREAMBLE,
  '',
  '[0–4秒｜镜头1]',
  '她从长椅间走向镜头 @Image1，脚步放慢。',
  '',
  '[4–11秒｜镜头2]',
  '走到近处停下微笑 @Image2，再低头看一眼包 @Image3。',
].join('\n')

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

const workspaces = new Map<string, Map<string, MockFile>>()

const generations = new Map<string, ReturnType<typeof job>[]>()

const VIDEO_DONE_MS = 3000

/** 重置 mock 时清除完成计时器，防止写入下一个用例。 */
const timers = new Set<ReturnType<typeof setTimeout>>()

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
      [
        'frames/grids/8e5263a4-3e52-4063-b0cd-5b6c7d8e9fa0.json',
        {
          content: JSON.stringify(
            {
              frames: [
                { no: 'S1-1', shot: 1, url: FRAME_A },
                { no: 'S2-1', shot: 2, url: FRAME_B },
                { no: 'S3-1', shot: 3, url: FRAME_C },
              ],
              gridRecordVersion: 1,
              jobId: '8e5263a4-3e52-4063-b0cd-5b6c7d8e9fa0',
            },
            null,
            2,
          ),
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

/** 修改第 2 组描述并递增版本；不存在工作区时返回 false。 */
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

/** 模拟结构校验：序号连续、时长 4–30 秒、帧引用不越界。 */
const validateShotsContent = (content: string): string | undefined => {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return '不是合法的 JSON'
  }
  const shots = (parsed as { shots?: unknown }).shots
  if (!Array.isArray(shots)) return '缺 shots'
  for (const [offset, shot] of (shots as Record<string, unknown>[]).entries()) {
    if (shot['index'] !== offset + 1) return `index 要从 1 连续编号，第 ${offset + 1} 条不是`
    const seconds = shot['seconds']
    if (typeof seconds !== 'number' || !Number.isInteger(seconds) || seconds < 4 || seconds > 30) {
      return `镜头组 ${offset + 1} 的 seconds 要是 4-30 的整数`
    }
    const urls = shot['imageUrls']
    const count = Array.isArray(urls) ? urls.length : 0
    const prompt = typeof shot['prompt'] === 'string' ? shot['prompt'] : ''
    for (const match of prompt.matchAll(/@Image(\d+)/g)) {
      if (Number(match[1]) > count)
        return `镜头组 ${offset + 1} 写到了 @Image${match[1]}，但只有 ${count} 张帧`
    }
  }
  return undefined
}

export const resetMockWorkspace = () => {
  for (const timer of timers) clearTimeout(timer)
  timers.clear()
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

  // 版本不匹配返回 409，内容结构无效返回 422；mock 不校验媒体地址。
  http.put('*/api/conversations/:conversationId/workspace/file', async ({ params, request }) => {
    const body = (await request.json()) as {
      content: string
      expectedVersion: number
      path: string
    }
    const files = workspaces.get(String(params['conversationId']))
    const file = files?.get(body.path)
    if (files === undefined || file === undefined) {
      return HttpResponse.json({ detail: '文件不存在，任何版本都对不上' }, { status: 409 })
    }
    if (file.version !== body.expectedVersion) {
      return HttpResponse.json(
        { detail: `版本对不上：现在是第 ${file.version} 版` },
        { status: 409 },
      )
    }
    if (body.path === SHOTS_MOCK_PATH) {
      const problem = validateShotsContent(body.content)
      if (problem !== undefined) return HttpResponse.json({ detail: problem }, { status: 422 })
    }
    const written: MockFile = {
      content: body.content,
      updatedAt: new Date().toISOString(),
      version: file.version + 1,
    }
    files.set(body.path, written)
    return HttpResponse.json({
      file: { content: written.content, path: body.path, version: written.version },
    })
  }),

  http.get('*/api/generations', ({ request }) => {
    const conversationId = new URL(request.url).searchParams.get('conversationId')
    const items = conversationId === null ? [] : (generations.get(conversationId) ?? [])
    return HttpResponse.json({ items })
  }),

  http.post('*/api/generations', async ({ request }) => {
    const body = (await request.json()) as {
      conversationId: string
      durationSeconds: number
      prompt: string
      shotIndex: number
    }
    const created = job({
      createdAt: new Date().toISOString(),
      id: crypto.randomUUID(),
      prompt: body.prompt,
      shotIndex: body.shotIndex,
      status: 'submitted',
    })
    created.conversationId = body.conversationId
    generations.set(body.conversationId, [...(generations.get(body.conversationId) ?? []), created])
    const timer = setTimeout(() => {
      created.finishedAt = new Date().toISOString()
      created.outputUrl = VIDEO_URL
      created.providerStatus = 'completed'
      created.status = 'completed'
      timers.delete(timer)
    }, VIDEO_DONE_MS)
    timers.add(timer)
    return HttpResponse.json({ generation: created }, { status: 202 })
  }),
]
