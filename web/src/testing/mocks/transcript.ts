/**
 * transcript 的 mock：一页历史（REST）加一条会说话的订阅连接（WebSocket）。
 *
 * 单测要确定的内容，各自 `server.use(...)` 覆盖这几条；`pnpm dev:mock` 与 e2e 用这一份，连上
 * 就会演一轮流式回复，好让页面在没有后端时也能看出效果。
 */

import { http, HttpResponse, ws } from 'msw'

/** 历史里有几轮。 */
const HISTORY_TURNS = 2

/** 历史那几轮对应的水位。演的那一轮从它之后接着编号。 */
const HISTORY_SEQ = 10

/** 演出来的那一轮，正文按这几段挤出来。 */
const DEMO_CHUNKS = ['好的，', '我先看一下这段素材，', '再把镜头表补齐。']

/** 一句正文的块 id 前缀：轮 3 的第 1 步。 */
const DEMO_STEP = 't3.1'

/**
 * 造一页历史。
 *
 * @returns `GET /transcript` 的响应体。
 */
export const mockTranscriptPage = () => ({
  agent_id: 'main',
  agents: [{ agentId: 'main', type: 'main' }],
  attachments: [],
  has_more: false,
  interactions: [],
  items: Array.from({ length: HISTORY_TURNS }, (_, index) => turnOf(index + 1)),
  meta: { activity: 'idle' },
  pending_interactions: [],
  prompts: [],
  seq: HISTORY_SEQ,
  tasks: [],
  todos: [],
})

/**
 * 历史里的一轮：用户一句、模型一句，第二轮里多一张工具卡。
 *
 * @param ordinal - 第几轮。
 * @returns 一轮的完整形状。
 */
const turnOf = (ordinal: number) => ({
  durationMs: 4200,
  endedAt: '2026-08-31T02:00:0'.concat(String(ordinal), 'Z'),
  kind: 'turn',
  ordinal,
  origin: { kind: 'user' },
  prompt: `第 ${ordinal} 个问题`,
  startedAt: '2026-08-31T01:59:5'.concat(String(ordinal), 'Z'),
  state: 'completed',
  steps: [
    {
      frames: [
        {
          frameId: `t${ordinal}.1.f1`,
          kind: 'text',
          role: 'user',
          text: `第 ${ordinal} 个问题`,
        },
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
  turnId: `t${ordinal}`,
})

const socket = ws.link('*/api/ws')

/** REST 两条加订阅连接一条。 */
export const transcriptHandlers = [
  http.get('*/api/conversations/:conversationId/transcript', () =>
    HttpResponse.json(mockTranscriptPage()),
  ),

  http.get('*/api/conversations/:conversationId/transcript/ops', () =>
    HttpResponse.json({ agent_id: 'main', batches: [], complete: true, latest_seq: HISTORY_SEQ }),
  ),

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

    let played = false
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
        JSON.stringify({
          id: frame.id,
          payload: { accepted: [conversationId] },
          type: 'ack',
        }),
      )
      client.send(
        JSON.stringify({
          payload: {
            agent_id: 'main',
            has_more_older: true,
            seq: HISTORY_SEQ,
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
      // 一条连接只演一次：重连或者切档位再订阅时不该又冒出一轮。
      if (played) return
      played = true
      playDemoTurn((payload) =>
        client.send(
          JSON.stringify({ payload, seq: payload.seq, session_id: conversationId, ...OPS_FRAME }),
        ),
      )
    })
  }),
]

const OPS_FRAME = { type: 'transcript.ops' } as const

type OpsPayload = { agent_id: string; ops: unknown[]; seq: number }

/**
 * 演一轮流式回复：开轮、开步、开块，正文一段段追加，最后收尾。
 *
 * @param send - 把一批操作发出去。
 */
const playDemoTurn = (send: (payload: OpsPayload) => void) => {
  const batches: unknown[][] = [
    [
      {
        op: 'turn.upsert',
        turn: {
          kind: 'turn',
          ordinal: 3,
          origin: { kind: 'user' },
          prompt: '把这段素材拆一下',
          startedAt: new Date().toISOString(),
          state: 'running',
          turnId: 't3',
        },
      },
      {
        op: 'frame.upsert',
        frame: { frameId: `${DEMO_STEP}.f1`, kind: 'text', role: 'user', text: '把这段素材拆一下' },
        stepId: DEMO_STEP,
        turnId: 't3',
      },
    ],
    [
      {
        op: 'step.upsert',
        step: { kind: 'step', ordinal: 1, state: 'running', stepId: DEMO_STEP, turnId: 't3' },
        turnId: 't3',
      },
      {
        op: 'frame.upsert',
        frame: { frameId: `${DEMO_STEP}.f2`, kind: 'text', role: 'assistant', text: '' },
        stepId: DEMO_STEP,
        turnId: 't3',
      },
    ],
    ...DEMO_CHUNKS.map((text, index) => [
      {
        op: 'append',
        offset: DEMO_CHUNKS.slice(0, index).join('').length,
        target: { frameId: `${DEMO_STEP}.f2`, stepId: DEMO_STEP, turnId: 't3', type: 'frame' },
        text,
      },
    ]),
    [
      {
        op: 'step.upsert',
        step: { kind: 'step', ordinal: 1, state: 'completed', stepId: DEMO_STEP, turnId: 't3' },
        turnId: 't3',
      },
      {
        op: 'turn.upsert',
        turn: {
          endedAt: new Date().toISOString(),
          kind: 'turn',
          ordinal: 3,
          origin: { kind: 'user' },
          prompt: '把这段素材拆一下',
          state: 'completed',
          turnId: 't3',
        },
      },
    ],
  ]

  batches.forEach((ops, index) => {
    setTimeout(
      () => send({ agent_id: 'main', ops, seq: HISTORY_SEQ + index + 1 }),
      600 * (index + 1),
    )
  })
}
