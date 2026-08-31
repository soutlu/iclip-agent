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

/** 演出来的回复，正文按这几段挤出来。 */
const DEMO_CHUNKS = ['好的，', '我先看一下这段素材，', '再把镜头表补齐。']

/** 演出来的那一轮里的思考正文。 */
const DEMO_THINKING = '先看看目录里已经有哪些镜头，再决定补哪几条。'

/** 每批操作之间隔多久：够看出是流式的，又不至于等。 */
const BEAT_MS = 500

type Batch = unknown[]

type Connection = {
  conversationId: string
  send: (payload: { agent_id: string; ops: Batch; seq: number }) => void
}

/** 连着的那几条连接。收下消息之后照它们广播。 */
const connections = new Set<Connection>()

/** 全局批次号与轮号。历史占了前两轮。 */
let seq = HISTORY_SEQ
let turns = HISTORY_TURNS

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
  items: Array.from({ length: HISTORY_TURNS }, (_, index) => historyTurn(index + 1)),
  meta: { activity: 'idle' },
  pending_interactions: [],
  prompts: [],
  seq: HISTORY_SEQ,
  tasks: [],
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
  prompt: `第 ${ordinal} 个问题`,
  startedAt: '2026-08-31T01:59:5'.concat(String(ordinal), 'Z'),
  state: 'completed',
  steps: [
    {
      frames: [
        { frameId: `t${ordinal}.1.f1`, kind: 'text', role: 'user', text: `第 ${ordinal} 个问题` },
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

/** REST 三条加订阅连接一条。 */
export const transcriptHandlers = [
  http.get('*/api/conversations/:conversationId/transcript', () =>
    HttpResponse.json(mockTranscriptPage()),
  ),

  http.get('*/api/conversations/:conversationId/transcript/ops', () =>
    HttpResponse.json({ agent_id: 'main', batches: [], complete: true, latest_seq: seq }),
  ),

  // POST /prompts：收下就当跑起来了，随后照着演一轮回复。
  http.post('*/api/conversations/:conversationId/prompts', async ({ params, request }) => {
    const body = (await request.json()) as { content: { text?: string }[]; prompt_id: string }
    const text = body.content.map((part) => part.text ?? '').join('')
    playTurn(String(params['conversationId']), { promptId: body.prompt_id, text })
    return HttpResponse.json({
      createdAt: new Date().toISOString(),
      promptId: body.prompt_id,
      status: 'running',
    })
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
            seq,
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
 * 演一轮：先认下这条消息，再开轮、开步、开块，正文一段段追加，最后收尾。
 *
 * @param conversationId - 哪一段对话。
 * @param prompt - 用户这一条。
 */
const playTurn = (conversationId: string, prompt: { promptId: string; text: string }) => {
  turns += 1
  const turnId = `t${turns}`
  const stepId = `${turnId}.1`
  const now = new Date().toISOString()
  const tool = (state: 'running' | 'done') => ({
    op: 'frame.upsert',
    frame: {
      display: { kind: 'file_io', operation: 'grep', path: 'shots/' },
      frameId: `${stepId}.call`,
      kind: 'tool',
      name: 'search_files',
      state,
      toolCallId: `${turnId}-call`,
    },
    stepId,
    turnId,
  })
  const turnHeader = (state: 'running' | 'completed') => ({
    op: 'turn.upsert',
    turn: {
      kind: 'turn',
      ordinal: turns,
      origin: { kind: 'user' },
      prompt: prompt.text,
      startedAt: now,
      state,
      turnId,
      ...(state === 'completed' ? { endedAt: new Date().toISOString() } : {}),
    },
  })

  const batches: Batch[] = [
    [
      {
        op: 'prompt.upsert',
        prompt: { createdAt: now, promptId: prompt.promptId, status: 'running' },
      },
      turnHeader('running'),
      {
        op: 'frame.upsert',
        frame: { frameId: `${stepId}.f1`, kind: 'text', role: 'user', text: prompt.text },
        stepId,
        turnId,
      },
    ],
    [
      {
        op: 'step.upsert',
        step: { kind: 'step', ordinal: 1, state: 'running', stepId, turnId },
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
    [
      tool('done'),
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
    [
      {
        op: 'step.upsert',
        step: { kind: 'step', ordinal: 1, state: 'completed', stepId, turnId },
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
  ]

  batches.forEach((ops, index) => {
    setTimeout(
      () => {
        seq += 1
        const payload = { agent_id: 'main', ops, seq }
        for (const connection of connections) {
          if (connection.conversationId === conversationId) connection.send(payload)
        }
      },
      BEAT_MS * (index + 1),
    )
  })
}
