/**
 * transcript 的 mock：一页历史（REST）、一条会说话的订阅连接（WebSocket），加收下消息之后
 * 照着演一轮回复。
 *
 * 单测要确定的内容，各自 `server.use(...)` 覆盖这几条；`pnpm dev:mock` 与 e2e 用这一份——发一句
 * 出去，气泡会被认领、回复会一段段长出来，不需要真后端。
 */

import { http, HttpResponse, ws } from 'msw'
import { SHOTS_MOCK_PATH, touchMockShots } from './workspace'

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

/** 媒体墙那两张镜头帧。同样是 data URL，不走外网。 */
const DEMO_FRAME_URLS = [
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='180'%3E%3Crect width='320' height='180' fill='%23e8dfd1'/%3E%3Crect x='96' y='54' width='128' height='72' fill='%23a8742a'/%3E%3C/svg%3E",
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='180'%3E%3Crect width='320' height='180' fill='%23d1dfe8'/%3E%3Cpolygon points='160,40 240,140 80,140' fill='%232a5f8a'/%3E%3C/svg%3E",
]

/** 每批操作之间隔多久：够看出是流式的，又不至于等。 */
const BEAT_MS = 500

/** 订上文件多久之后演 agent 改一次：留出打开面板、翻两组的时间。 */
const FS_CHANGE_DELAY_MS = 5000

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

/** 一条消息的 part：与发消息接口的 content 同形。 */
type PromptContent =
  { type: 'text'; text: string } | { type: 'image' | 'video'; source: { kind: 'url'; url: string } }

type Prompt = { promptId: string; text: string; content: PromptContent[] }

type Active = Prompt & { ordinal: number; turnId: string }

/** 每段对话此刻在跑的那条，与排着的那些。真后端里这是 prompts 表。 */
const running = new Map<string, Active>()
const queues = new Map<string, Prompt[]>()

/** 已经排上的定时器：停止的时候把没发的那几批撤掉。 */
const timers = new Map<string, ReturnType<typeof setTimeout>[]>()

/** 停在审批上的那几段对话：历史里多一轮等人点头的活儿，订上也不再演新的一轮。 */
const awaitingApproval = new Set<string>()

/** 记下的决定。重复点同一个照样 204，改主意是 409——与真后端同一条规矩。 */
const decisions = new Map<string, boolean>()

const APPROVAL_TURN_ID = 'ta'
const APPROVAL_STEP_ID = `${APPROVAL_TURN_ID}.1`
const APPROVAL_INTERACTION_ID = 'appr_1'
const APPROVAL_TOOL_CALL_ID = 'call_cover'
const APPROVAL_PROMPT_ID = 'p_cover'
const APPROVAL_PROMPT_TEXT = '把这两张镜头帧拼成封面'

/**
 * 让一段对话停在审批上：那一轮仍在跑（等人不是停下），末尾一次调用挂着待回应的交互。
 *
 * @param conversationId - 哪一段对话。
 */
export const markMockAwaitingApproval = (conversationId: string) => {
  awaitingApproval.add(conversationId)
  running.set(conversationId, {
    content: [{ text: APPROVAL_PROMPT_TEXT, type: 'text' }],
    ordinal: 3,
    promptId: APPROVAL_PROMPT_ID,
    text: APPROVAL_PROMPT_TEXT,
    turnId: APPROVAL_TURN_ID,
  })
}

/** 等人点头的那次调用。决定落下来之后原样改 state 再发一次。 */
const approvalFrame = (state: 'running' | 'done' | 'error') => ({
  approvalId: APPROVAL_INTERACTION_ID,
  display: { kind: 'file_io', operation: 'write', path: 'shots/cover.md' },
  frameId: `${APPROVAL_STEP_ID}.f4`,
  input: { path: 'shots/cover.md', text: '# 封面\n\n两张镜头帧拼版，主图在左。' },
  kind: 'tool',
  name: 'write_file',
  state,
  toolCallId: APPROVAL_TOOL_CALL_ID,
  ...(state === 'done' ? { output: '已写入 8 行' } : {}),
  ...(state === 'error' ? { error: '你拒绝了这一步' } : {}),
})

/**
 * 停在审批上的那一轮：一次读规范、一次出图（媒体墙），末尾一次等人点头的写文件。
 *
 * 三件新卡都在这一轮里：读规范与出图之间隔一句正文，免得连着的工具行折进活动组。
 *
 * @returns 一轮的完整形状。
 */
const approvalTurn = () => ({
  kind: 'turn',
  ordinal: 3,
  origin: { kind: 'user' },
  content: [{ text: APPROVAL_PROMPT_TEXT, type: 'text' }],
  startedAt: '2026-08-31T02:10:00Z',
  state: 'running',
  steps: [
    {
      frames: [
        {
          display: { kind: 'skill_call', skill_name: '分镜脚本', args: '镜头节奏.md' },
          frameId: `${APPROVAL_STEP_ID}.f1`,
          kind: 'tool',
          name: 'get_skill_reference',
          output: '一条镜头一个动作；封面取全片最亮的那一帧。',
          state: 'done',
          toolCallId: 'call_skill',
        },
        {
          frameId: `${APPROVAL_STEP_ID}.f2`,
          kind: 'text',
          role: 'assistant',
          text: '两张镜头帧出好了：',
        },
        {
          display: { kind: 'generic', summary: '出镜头帧' },
          frameId: `${APPROVAL_STEP_ID}.f3`,
          kind: 'tool',
          metadata: {
            items: [
              { caption: 'S01 · 产品特写', url: DEMO_FRAME_URLS[0] },
              { caption: 'S02 · 场景全景', url: DEMO_FRAME_URLS[1] },
            ],
          },
          name: 'generate_shot_frames',
          output: '出好了 2 张',
          state: 'done',
          toolCallId: 'call_frames',
          view: 'media_grid',
        },
        approvalFrame('running'),
      ],
      kind: 'step',
      ordinal: 1,
      startedAt: '2026-08-31T02:10:00Z',
      state: 'running',
      stepId: APPROVAL_STEP_ID,
      turnId: APPROVAL_TURN_ID,
    },
  ],
  turnId: APPROVAL_TURN_ID,
})

/** 待回应的那张卡。 */
const pendingApproval = {
  interactionId: APPROVAL_INTERACTION_ID,
  interactionKind: 'approval',
  state: 'pending',
  toolCallId: APPROVAL_TOOL_CALL_ID,
}

/**
 * 造一页历史。停在审批上的那几段对话多一轮等人点头的活儿。
 *
 * @param conversationId - 哪一段对话；不给就是普通的那份历史。
 * @returns `GET /transcript` 的响应体。
 */
export const mockTranscriptPage = (conversationId = '') => {
  const awaiting = awaitingApproval.has(conversationId)
  return {
    agent_id: 'main',
    agents: [{ agentId: 'main', type: 'main' }],
    has_more: false,
    interactions: awaiting ? [pendingApproval] : [],
    items: [
      ...Array.from({ length: HISTORY_TURNS }, (_, index) => historyTurn(index + 1)),
      ...(awaiting ? [approvalTurn()] : []),
    ],
    meta: {
      activity: awaiting ? 'turn' : 'idle',
      agent: { contextTokens: 32768, contextUsage: 0.03125, maxContextTokens: 1048576 },
    },
    pending_interactions: awaiting ? [APPROVAL_INTERACTION_ID] : [],
    prompts: awaiting
      ? [
          {
            content: [{ text: APPROVAL_PROMPT_TEXT, type: 'text' }],
            createdAt: '2026-08-31T02:10:00Z',
            promptId: APPROVAL_PROMPT_ID,
            status: 'running',
          },
        ]
      : [],
    seq: HISTORY_SEQ,
    tasks: [],
    title: '夜景延时素材生成',
    todos: [],
  }
}

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
  // 第一轮带一张参考图，夹在两句话中间：气泡按原顺序画 part 就靠它看出来
  content:
    ordinal === 1
      ? [
          { text: '参考这张图：', type: 'text' },
          { source: { kind: 'url', url: DEMO_IMAGE_URL }, type: 'image' },
          { text: '\n第 1 个问题', type: 'text' },
        ]
      : [{ text: `第 ${ordinal} 个问题`, type: 'text' }],
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
  http.get('*/api/conversations/:conversationId/transcript', ({ params }) =>
    HttpResponse.json(mockTranscriptPage(String(params['conversationId']))),
  ),

  // POST /interactions/{id}：点同意或拒绝。记下决定就 204，随后照决定把那一轮演完。
  http.post(
    '*/api/conversations/:conversationId/interactions/:interactionId',
    async ({ params, request }) => {
      const body = (await request.json()) as { approved: boolean }
      const conversationId = String(params['conversationId'])
      const interactionId = String(params['interactionId'])
      const key = `${conversationId}:${interactionId}`
      const decided = decisions.get(key)
      if (decided !== undefined) {
        return decided === body.approved
          ? new HttpResponse(null, { status: 204 })
          : HttpResponse.json({ detail: '这张卡已经做过决定了' }, { status: 409 })
      }
      if (!awaitingApproval.has(conversationId) || interactionId !== APPROVAL_INTERACTION_ID) {
        return HttpResponse.json({ detail: '这张卡不在等回应' }, { status: 404 })
      }
      decisions.set(key, body.approved)
      awaitingApproval.delete(conversationId)
      settleApproval(conversationId, body.approved)
      return new HttpResponse(null, { status: 204 })
    },
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
    const body = (await request.json()) as { content: PromptContent[]; prompt_id: string }
    const conversationId = String(params['conversationId'])
    const prompt = {
      content: body.content,
      promptId: body.prompt_id,
      text: body.content.map((part) => (part.type === 'text' ? part.text : '')).join(''),
    }
    const busy = running.has(conversationId)
    if (busy) {
      queues.set(conversationId, [...(queues.get(conversationId) ?? []), prompt])
      broadcast(conversationId, [
        {
          op: 'prompt.upsert',
          prompt: {
            content: prompt.content,
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
    // 这条连接已经排过改文件的那几段对话。React 严格模式挂载两遍，不去重就会推两帧、版本跳两级。
    const fsScheduled = new Set<string>()
    client.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return
      const frame = JSON.parse(event.data) as {
        id?: string
        payload?: { paths?: string[]; session_id?: string }
        type?: string
      }

      if (frame.type === 'watch_fs_add' || frame.type === 'watch_fs_remove') {
        const watched = frame.payload?.paths ?? []
        client.send(
          JSON.stringify({
            id: frame.id,
            payload: { current_count: watched.length, watched_paths: watched },
            type: 'ack',
          }),
        )
        const conversationId = frame.payload?.session_id ?? ''
        if (frame.type !== 'watch_fs_add' || fsScheduled.has(conversationId)) return
        fsScheduled.add(conversationId)
        // 订上一会儿之后演一次 agent 改文件：面板重读文件、标出「agent 刚改过」。
        setTimeout(() => {
          if (!touchMockShots(conversationId)) return
          client.send(
            JSON.stringify({
              payload: {
                changes: [{ change: 'modified', kind: 'file', path: SHOTS_MOCK_PATH }],
                coalesced_window_ms: 0,
              },
              session_id: conversationId,
              type: 'event.fs.changed',
            }),
          )
        }, FS_CHANGE_DELAY_MS)
        return
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
      // 一订上就先演一轮：不发消息也看得见流式长什么样。停在审批上的那几段不演——它在等人。
      if (!awaitingApproval.has(conversationId)) {
        playTurn(conversationId, {
          content: [{ text: '把这段素材拆一下', type: 'text' }],
          promptId: 'demo',
          text: '把这段素材拆一下',
        })
      }
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
        content: active.content,
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

/**
 * 决定落下来之后把那一轮演完：交互改成终态，等着的那次调用照决定收场，轮子结束，接上队列。
 *
 * @param conversationId - 哪一段对话。
 * @param approved - 同意还是拒绝。
 */
const settleApproval = (conversationId: string, approved: boolean) => {
  const now = new Date().toISOString()
  broadcast(conversationId, [
    {
      interaction: { ...pendingApproval, state: approved ? 'approved' : 'rejected' },
      op: 'interaction.upsert',
    },
    {
      frame: approvalFrame(approved ? 'done' : 'error'),
      op: 'frame.upsert',
      stepId: APPROVAL_STEP_ID,
      turnId: APPROVAL_TURN_ID,
    },
    {
      frame: {
        frameId: `${APPROVAL_STEP_ID}.f5`,
        kind: 'text',
        role: 'assistant',
        text: approved ? '封面写好了。' : '好，这一步跳过。',
      },
      op: 'frame.upsert',
      stepId: APPROVAL_STEP_ID,
      turnId: APPROVAL_TURN_ID,
    },
    {
      op: 'step.upsert',
      step: {
        endedAt: now,
        kind: 'step',
        ordinal: 1,
        state: 'completed',
        stepId: APPROVAL_STEP_ID,
        turnId: APPROVAL_TURN_ID,
      },
      turnId: APPROVAL_TURN_ID,
    },
    {
      op: 'turn.upsert',
      turn: {
        endedAt: now,
        kind: 'turn',
        ordinal: 3,
        origin: { kind: 'user' },
        content: [{ text: APPROVAL_PROMPT_TEXT, type: 'text' }],
        state: 'completed',
        turnId: APPROVAL_TURN_ID,
      },
    },
    {
      op: 'prompt.upsert',
      prompt: {
        createdAt: '2026-08-31T02:10:00Z',
        finishedAt: now,
        promptId: APPROVAL_PROMPT_ID,
        status: 'completed',
      },
    },
    { meta: { activity: 'idle' }, op: 'meta.merge' },
  ])
  running.delete(conversationId)
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
      frame: {
        content: prompt.content,
        frameId: `${stepId}.steer`,
        kind: 'text',
        role: 'user',
        text: prompt.text,
      },
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
      content: prompt.content,
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

  // 头一批当场发：开场输入只在轮头部的 content，user frame 留给中途插话。订阅还没上来时这一批
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
