/**
 * transcript 的 mock：一页历史（REST）、一条会说话的订阅连接（WebSocket），加收下消息之后
 * 照着演一轮回复。
 *
 * 单测要确定的内容，各自 `server.use(...)` 覆盖这几条；`pnpm dev:mock` 与 e2e 用这一份——发一句
 * 出去，气泡会被认领、回复会一段段长出来，不需要真后端。
 */

import { http, HttpResponse, ws } from 'msw'

/** 历史里有几轮。 */
const HISTORY_TURNS = 2

/** 历史那几轮对应的水位。之后每一批从它往上编号。 */
const HISTORY_SEQ = 10

/** 演出来的回复，正文按这几段挤出来。带点 markdown，好看出渲染是不是接上了。 */
const DEMO_CHUNKS = [
  '好的，我先看一下这段素材：\n\n',
  '- 拆出 3 个镜头\n- 写进 `shots/storyboard.md`\n\n',
  '生成参数也定好了：\n\n```json\n{\n  "shots": 3,\n  "fps": 5,\n  "ratio": "9:16"\n}\n```\n\n',
  '**镜头表已经更新。**\n\n<details><summary>看设定</summary>\n\n| 镜头 | 时长 |\n| --- | --- |\n| S01 | 2.4s |\n\n</details>',
]

/** 演出来的那一轮里的思考正文。 */
const DEMO_THINKING = '先看看目录里已经有哪些镜头，再决定补哪几条。'

/** 历史第一条消息带的参考图：本地 data URL，mock 环境离线也能渲染。 */
const DEMO_IMAGE_URL =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='180'%3E%3Crect width='320' height='180' fill='%23d1e8d6'/%3E%3Ccircle cx='160' cy='90' r='48' fill='%23006d42'/%3E%3C/svg%3E"

/** 那张参考图的附件实体：挂在历史第一页，随基线落地。 */
const DEMO_ATTACHMENT = {
  attachmentId: 'att_demo_image',
  mediaType: 'image/svg+xml',
  name: '参考图.svg',
  size: 438,
  source: { kind: 'url', url: DEMO_IMAGE_URL },
}

/** 每批操作之间隔多久：够看出是流式的，又不至于等。 */
const BEAT_MS = 500

type Batch = unknown[]

type Connection = {
  conversationId: string
  send: (payload: { agent_id: string; ops: Batch; seq: number }) => void
}

/** 连着的那几条连接。收下消息之后照它们广播。 */
const connections = new Set<Connection>()

/** 轮号。历史占了前两轮。 */
let turns = HISTORY_TURNS

/** 每段对话的批次号与批次日志。日志是补批端点的货源——少了它，客户端一跳号就再也接不上。 */
const seqOf = new Map<string, number>()
const logOf = new Map<string, { ops: Batch; seq: number }[]>()

type Prompt = { promptId: string; text: string }

type Active = Prompt & { ordinal: number; turnId: string }

/** 每段对话此刻在跑的那条，与排着的那些。真后端里这是 prompts 表。 */
const running = new Map<string, Active>()
const queues = new Map<string, Prompt[]>()

/** 已经排上的定时器：停止的时候把没发的那几批撤掉。 */
const timers = new Map<string, ReturnType<typeof setTimeout>[]>()

/**
 * 造一页历史。
 *
 * @returns `GET /transcript` 的响应体。
 */
export const mockTranscriptPage = () => ({
  agent_id: 'main',
  agents: [{ agentId: 'main', type: 'main' }],
  attachments: [DEMO_ATTACHMENT],
  has_more: false,
  interactions: [],
  items: Array.from({ length: HISTORY_TURNS }, (_, index) => historyTurn(index + 1)),
  meta: { activity: 'idle' },
  pending_interactions: [],
  prompts: [],
  seq: HISTORY_SEQ,
  tasks: [],
  title: '夜景延时素材生成',
  todos: [],
})

/**
 * 历史里的一轮：用户一句、模型一句，第二轮里多一次工具调用。
 *
 * @param ordinal - 第几轮。
 * @returns 一轮的完整形状。
 */
const historyTurn = (ordinal: number) => ({
  durationMs: 4200,
  endedAt: '2026-08-31T02:00:0'.concat(String(ordinal), 'Z'),
  kind: 'turn',
  ordinal,
  origin: { kind: 'user' },
  attachmentIds: ordinal === 1 ? [DEMO_ATTACHMENT.attachmentId] : undefined,
  prompt: `第 ${ordinal} 个问题`,
  startedAt: '2026-08-31T01:59:5'.concat(String(ordinal), 'Z'),
  state: 'completed',
  steps: [
    {
      frames: [
        ...(ordinal === HISTORY_TURNS
          ? [
              {
                display: { kind: 'file_io', operation: 'read', path: 'shots/storyboard.md' },
                frameId: `t${ordinal}.1.f2`,
                kind: 'tool',
                name: 'read_file',
                state: 'done',
                toolCallId: `call_${ordinal}`,
              },
            ]
          : []),
        {
          frameId: `t${ordinal}.1.f3`,
          kind: 'text',
          role: 'assistant',
          text: `这是第 ${ordinal} 轮的回复。`,
        },
      ],
      kind: 'step',
      ordinal: 1,
      state: 'completed',
      stepId: `t${ordinal}.1`,
      turnId: `t${ordinal}`,
    },
  ],
  usage: { cachedTokens: 4910, inputTokens: 12340, outputTokens: 1214 },
  turnId: `t${ordinal}`,
})

const socket = ws.link('*/api/ws')

/** REST 三条加订阅连接一条。 */
export const transcriptHandlers = [
  http.get('*/api/conversations/:conversationId/transcript', () =>
    HttpResponse.json(mockTranscriptPage()),
  ),

  // GET /transcript/ops：把 since 之后的批次原样给回去。基线永远是那两轮历史，演出来的那些
  // 全靠这条补——它返回空的话，客户端跳一次号就再也接不上了。
  http.get('*/api/conversations/:conversationId/transcript/ops', ({ params, request }) => {
    const conversationId = String(params['conversationId'])
    const since = Number(new URL(request.url).searchParams.get('since_seq') ?? 0)
    const log = logOf.get(conversationId) ?? []
    return HttpResponse.json({
      agent_id: 'main',
      batches: log.filter((batch) => batch.seq > since),
      complete: true,
      latest_seq: seqOf.get(conversationId) ?? HISTORY_SEQ,
    })
  }),

  // POST /prompts：空着就地开跑，忙着就排队——与真后端同一条规矩。
  http.post('*/api/conversations/:conversationId/prompts', async ({ params, request }) => {
    const body = (await request.json()) as { content: { text?: string }[]; prompt_id: string }
    const conversationId = String(params['conversationId'])
    const prompt = {
      promptId: body.prompt_id,
      text: body.content.map((p) => p.text ?? '').join(''),
    }
    const busy = running.has(conversationId)
    if (busy) {
      queues.set(conversationId, [...(queues.get(conversationId) ?? []), prompt])
      broadcast(conversationId, [
        {
          op: 'prompt.upsert',
          prompt: {
            content: [{ text: prompt.text, type: 'text' }],
            createdAt: new Date().toISOString(),
            promptId: prompt.promptId,
            status: 'queued',
          },
        },
      ])
    } else {
      playTurn(conversationId, prompt)
    }
    return HttpResponse.json({
      createdAt: new Date().toISOString(),
      promptId: prompt.promptId,
      status: busy ? 'queued' : 'running',
    })
  }),

  // POST /prompts:steer：把排着的那条插进当前这一轮——这里简化成「当场跑它」。
  http.post('*/api/conversations/:conversationId/prompts:steer', async ({ params, request }) => {
    const body = (await request.json()) as { prompt_ids: string[] }
    const conversationId = String(params['conversationId'])
    const queue = queues.get(conversationId) ?? []
    const picked = queue.filter((prompt) => body.prompt_ids.includes(prompt.promptId))
    if (picked.length === 0)
      return HttpResponse.json({ detail: '这条已经不在队列里了' }, { status: 404 })
    queues.set(
      conversationId,
      queue.filter((prompt) => !body.prompt_ids.includes(prompt.promptId)),
    )
    for (const prompt of picked) steerInto(conversationId, prompt)
    return new HttpResponse(null, { status: 204 })
  }),

  // POST /prompts/{id}:abort：在跑的收尾，排着的撤掉。
  // 路径写成通配再自己取 id：`:promptId:abort` 这种写法 path-to-regexp 解析不了，会把整份
  // handler 查找搞崩（连 /src/main.tsx 都 500），页面直接白屏。
  http.post('*/api/conversations/:conversationId/prompts/*', ({ params, request }) => {
    const conversationId = String(params['conversationId'])
    const tail = new URL(request.url).pathname.split('/').pop() ?? ''
    const promptId = decodeURIComponent(tail).replace(/:abort$/, '')
    const queue = queues.get(conversationId) ?? []
    if (queue.some((prompt) => prompt.promptId === promptId)) {
      queues.set(
        conversationId,
        queue.filter((prompt) => prompt.promptId !== promptId),
      )
      broadcast(conversationId, [
        {
          op: 'prompt.upsert',
          prompt: {
            createdAt: new Date().toISOString(),
            promptId,
            status: 'aborted',
          },
        },
      ])
      return new HttpResponse(null, { status: 204 })
    }
    if (running.get(conversationId)?.promptId !== promptId) {
      return HttpResponse.json({ detail: '这条早就结束了' }, { status: 409 })
    }
    stopTurn(conversationId)
    return new HttpResponse(null, { status: 204 })
  }),

  socket.addEventListener('connection', ({ client }) => {
    client.send(
      JSON.stringify({
        payload: {
          heartbeat_ms: 10_000,
          max_event_buffer_size: 2048,
          protocol_version: 2,
          ws_connection_id: 'mock',
        },
        type: 'server_hello',
      }),
    )

    let joined: Connection | null = null
    client.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return
      const frame = JSON.parse(event.data) as {
        id?: string
        payload?: { session_id?: string }
        type?: string
      }
      if (frame.type !== 'subscribe_v2') return
      const conversationId = frame.payload?.session_id ?? ''
      client.send(
        JSON.stringify({ id: frame.id, payload: { accepted: [conversationId] }, type: 'ack' }),
      )
      client.send(
        JSON.stringify({
          payload: {
            agent_id: 'main',
            has_more_older: true,
            seq: seqOf.get(conversationId) ?? HISTORY_SEQ,
            snapshot: {
              attachments: [],
              interactions: [],
              items: [],
              meta: {},
              prompts: [],
              tasks: [],
              todos: [],
            },
          },
          seq: 1,
          session_id: conversationId,
          type: 'transcript.reset',
        }),
      )
      if (joined !== null) return
      joined = {
        conversationId,
        send: (payload) =>
          client.send(
            JSON.stringify({
              payload,
              seq: payload.seq,
              session_id: conversationId,
              type: 'transcript.ops',
            }),
          ),
      }
      connections.add(joined)
      // 一订上就先演一轮：不发消息也看得见流式长什么样。
      playTurn(conversationId, { promptId: 'demo', text: '把这段素材拆一下' })
    })

    client.addEventListener('close', () => {
      if (joined !== null) connections.delete(joined)
    })
  }),
]

/**
 * 把一批操作发给订着这段对话的那几条连接。
 *
 * @param conversationId - 哪一段对话。
 * @param ops - 这一批。
 */
const broadcast = (conversationId: string, ops: Batch) => {
  const seq = (seqOf.get(conversationId) ?? HISTORY_SEQ) + 1
  seqOf.set(conversationId, seq)
  logOf.set(conversationId, [...(logOf.get(conversationId) ?? []), { ops, seq }])
  const payload = { agent_id: 'main', ops, seq }
  for (const connection of connections) {
    if (connection.conversationId === conversationId) connection.send(payload)
  }
}

type Scheduled = Batch | (() => Batch)

/** 排一批：定时发出去，并记下定时器，好让停止能撤掉还没发的那些。函数批次在发的那一刻现取。 */
const schedule = (conversationId: string, batches: Scheduled[], done?: () => void) => {
  const handles = batches.map((ops, index) =>
    setTimeout(
      () => broadcast(conversationId, typeof ops === 'function' ? ops() : ops),
      BEAT_MS * (index + 1),
    ),
  )
  handles.push(setTimeout(() => done?.(), BEAT_MS * (batches.length + 1)))
  timers.set(conversationId, [...(timers.get(conversationId) ?? []), ...handles])
}

/**
 * 停掉在跑的那一轮：没发的批次撤掉，轮子收成取消，队列里下一条接着上。
 *
 * @param conversationId - 哪一段对话。
 */
const stopTurn = (conversationId: string) => {
  for (const handle of timers.get(conversationId) ?? []) clearTimeout(handle)
  timers.delete(conversationId)
  const active = running.get(conversationId)
  running.delete(conversationId)
  if (active === undefined) return
  broadcast(conversationId, [
    {
      op: 'turn.upsert',
      turn: {
        endedAt: new Date().toISOString(),
        kind: 'turn',
        ordinal: active.ordinal,
        origin: { kind: 'user' },
        prompt: active.text,
        state: 'cancelled',
        turnId: active.turnId,
      },
    },
    {
      op: 'prompt.upsert',
      prompt: {
        createdAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        promptId: active.promptId,
        status: 'aborted',
      },
    },
  ])
  drain(conversationId)
}

/** 队列里还有就接着跑下一条。 */
const drain = (conversationId: string) => {
  const queue = queues.get(conversationId) ?? []
  const next = queue.shift()
  queues.set(conversationId, queue)
  if (next !== undefined) playTurn(conversationId, next)
}

/**
 * 把一条排着的消息插进正在跑的那一轮：用户那句接在当前这一步后面，再补一段正文。
 *
 * @param conversationId - 哪一段对话。
 * @param prompt - 被插进来的那条。
 */
const steerInto = (conversationId: string, prompt: Prompt) => {
  const active = running.get(conversationId)
  if (active === undefined) {
    playTurn(conversationId, prompt)
    return
  }
  const stepId = `${active.turnId}.1`
  broadcast(conversationId, [
    {
      op: 'prompt.upsert',
      prompt: { createdAt: new Date().toISOString(), promptId: prompt.promptId, status: 'running' },
    },
    {
      op: 'frame.upsert',
      frame: { frameId: `${stepId}.steer`, kind: 'text', role: 'user', text: prompt.text },
      stepId,
      turnId: active.turnId,
    },
  ])
  schedule(conversationId, [
    [
      {
        op: 'frame.upsert',
        frame: { frameId: `${stepId}.f4`, kind: 'text', role: 'assistant', text: '收到，一起做。' },
        stepId,
        turnId: active.turnId,
      },
    ],
  ])
}

/**
 * 演一轮：先认下这条消息，再开轮、开步、开块，正文一段段追加，最后收尾并接上队列。
 *
 * @param conversationId - 哪一段对话。
 * @param prompt - 用户这一条。
 */
const playTurn = (conversationId: string, prompt: Prompt) => {
  turns += 1
  const turnId = `t${turns}`
  const stepId = `${turnId}.1`
  const ordinal = turns
  const now = new Date().toISOString()
  running.set(conversationId, { ...prompt, ordinal, turnId })

  const tool = (state: 'running' | 'done') => ({
    op: 'frame.upsert',
    frame: {
      display: { kind: 'file_io', operation: 'grep', path: 'shots/' },
      frameId: `${stepId}.call`,
      kind: 'tool',
      name: 'search_files',
      output: state === 'done' ? 'shots/s01.md\nshots/s02.md\nshots/s03.md' : undefined,
      state,
      toolCallId: `${turnId}-call`,
    },
    stepId,
    turnId,
  })
  // 第二件工具（写文件）：连着第一件，让「连续工具调用折成活动组」有东西可折
  const tool2 = (state: 'running' | 'done') => ({
    op: 'frame.upsert',
    frame: {
      display: { kind: 'file_io', operation: 'write', path: 'shots/storyboard.md' },
      frameId: `${stepId}.call2`,
      kind: 'tool',
      name: 'write_file',
      output: state === 'done' ? '已写入 12 行' : undefined,
      state,
      toolCallId: `${turnId}-call2`,
    },
    stepId,
    turnId,
  })
  const turnHeader = (state: 'running' | 'completed') => ({
    op: 'turn.upsert',
    turn: {
      kind: 'turn',
      ordinal,
      origin: { kind: 'user' },
      prompt: prompt.text,
      startedAt: now,
      state,
      turnId,
      ...(state === 'completed'
        ? {
            endedAt: new Date().toISOString(),
            usage: { cachedTokens: 3080, inputTokens: 8230, outputTokens: 964 },
          }
        : {}),
    },
  })

  // 头一批当场发：开场输入只在 turn.prompt，user frame 留给中途插话。订阅还没上来时这一批
  // 会丢，但补批日志里有它，客户端一跳号就补回来。
  broadcast(conversationId, [
    {
      op: 'prompt.upsert',
      prompt: { createdAt: now, promptId: prompt.promptId, status: 'running' },
    },
    turnHeader('running'),
  ])

  schedule(
    conversationId,
    [
      [
        {
          op: 'step.upsert',
          step: { kind: 'step', ordinal: 1, startedAt: now, state: 'running', stepId, turnId },
          turnId,
        },
        {
          op: 'frame.upsert',
          frame: { frameId: `${stepId}.f2`, kind: 'thinking', text: DEMO_THINKING },
          stepId,
          turnId,
        },
        tool('running'),
      ],
      [tool('done'), tool2('running')],
      [
        tool2('done'),
        {
          op: 'frame.upsert',
          frame: { frameId: `${stepId}.f3`, kind: 'text', role: 'assistant', text: '' },
          stepId,
          turnId,
        },
      ],
      ...DEMO_CHUNKS.map((text, index) => [
        {
          offset: DEMO_CHUNKS.slice(0, index).join('').length,
          op: 'append',
          target: { frameId: `${stepId}.f3`, stepId, turnId, type: 'frame' },
          text,
        },
      ]),
      () => [
        {
          op: 'step.upsert',
          step: {
            endedAt: new Date().toISOString(),
            kind: 'step',
            ordinal: 1,
            state: 'completed',
            stepId,
            turnId,
          },
          turnId,
        },
        turnHeader('completed'),
        {
          op: 'prompt.upsert',
          prompt: {
            createdAt: now,
            finishedAt: new Date().toISOString(),
            promptId: prompt.promptId,
            status: 'completed',
          },
        },
      ],
    ],
    () => {
      timers.delete(conversationId)
      running.delete(conversationId)
      drain(conversationId)
    },
  )
}
