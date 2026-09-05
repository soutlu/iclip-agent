/** MSW 同时模拟 REST 历史、WebSocket 批次和消息提交；单测可覆盖端点以固定场景。 */

import { http, HttpResponse, ws } from 'msw'
import { SHOTS_MOCK_PATH, touchMockShots } from './workspace'

const HISTORY_TURNS = 2

const HISTORY_SEQ = 10

const DEMO_CHUNKS = [
  '好的，我先看一下这段素材：\n\n',
  '- 拆出 3 个镜头\n- 写进 `shots/storyboard.md`\n\n',
  '生成参数也定好了：\n\n```json\n{\n  "shots": 3,\n  "fps": 5,\n  "ratio": "9:16"\n}\n```\n\n',
  '**镜头表已经更新。**\n\n<details><summary>看设定</summary>\n\n| 镜头 | 时长 |\n| --- | --- |\n| S01 | 2.4s |\n\n</details>',
]

const DEMO_THINKING = '先看看目录里已经有哪些镜头，再决定补哪几条。'

/** 使用 data URL 参考图，避免网络依赖。 */
const DEMO_IMAGE_URL =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='180'%3E%3Crect width='320' height='180' fill='%23d1e8d6'/%3E%3Ccircle cx='160' cy='90' r='48' fill='%23006d42'/%3E%3C/svg%3E"

const DEMO_FRAME_URLS = [
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='180'%3E%3Crect width='320' height='180' fill='%23e8dfd1'/%3E%3Crect x='96' y='54' width='128' height='72' fill='%23a8742a'/%3E%3C/svg%3E",
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='180'%3E%3Crect width='320' height='180' fill='%23d1dfe8'/%3E%3Cpolygon points='160,40 240,140 80,140' fill='%232a5f8a'/%3E%3C/svg%3E",
]

const BEAT_MS = 500

/** 延迟文件更新，保留打开面板和切组的操作时间。 */
const FS_CHANGE_DELAY_MS = 5000

const WORK_DONE_DELAY_MS = 2000

type Batch = unknown[]

type Connection = {
  conversationId: string
  /** 这条连接订了哪些 agent 的流；主流与子代理流各自推送。 */
  agents: Set<string>
  send: (payload: { agent_id: string; ops: Batch; seq: number }) => void
}

const connections = new Set<Connection>()

let turns = HISTORY_TURNS

/** 批次号与日志按 (对话, agent) 各记一套，补发端点按同一把钥匙读。 */
const streamKey = (conversationId: string, agentId: string) => `${conversationId}/${agentId}`
const seqOf = new Map<string, number>()
const logOf = new Map<string, { ops: Batch; seq: number }[]>()

export const MOCK_CHILD_AGENT = 'shot-writer'
export const MOCK_CHILD_TASK = '写第 3 组的三个镜头'
export const MOCK_CHILD_REPLY = 'S3-1 特写：鞋头压过水面；S3-2 中景：起跑；S3-3 全景：冲线。'
/** 历史第 2 轮派出的子代理，一开始就是完成的；演示运行另派一个，边跑边填。 */
export const MOCK_HISTORY_CHILD = 't2-child'
export const MOCK_HISTORY_DELEGATE_CALL = 'call_t2_delegate'

/** 子代理流的进度：文本用整块替换，页与推送才对得上。 */
const children = new Map<string, { text: string; done: boolean }>([
  [MOCK_HISTORY_CHILD, { done: true, text: MOCK_CHILD_REPLY }],
])

type PromptContent =
  { type: 'text'; text: string } | { type: 'image' | 'video'; source: { kind: 'url'; url: string } }

type Prompt = { promptId: string; text: string; content: PromptContent[] }

type Active = Prompt & { ordinal: number; turnId: string }

const running = new Map<string, Active>()
const queues = new Map<string, Prompt[]>()

/** 按对话记录定时器，停止时取消尚未发送的批次。 */
const timers = new Map<string, ReturnType<typeof setTimeout>[]>()

/** 待审批会话使用固定未结束轮次，不自动启动演示运行。 */
const awaitingApproval = new Set<string>()

const justFinished = new Set<{ id: string; lastRunId: string | null }>()

/** 连接后更新行上的 lastRunId 并发送结束事件，模拟未读运行。 */
export const markMockJustFinished = (conversation: { id: string; lastRunId: string | null }) => {
  justFinished.add(conversation)
}

/** 重复相同决定返回 204，不同决定返回 409，与后端一致。 */
const decisions = new Map<string, boolean>()

const APPROVAL_TURN_ID = 'ta'
const APPROVAL_STEP_ID = `${APPROVAL_TURN_ID}.1`
const APPROVAL_INTERACTION_ID = 'appr_1'
const APPROVAL_TOOL_CALL_ID = 'call_cover'
const APPROVAL_PROMPT_ID = 'p_cover'
const APPROVAL_PROMPT_TEXT = '把这两张镜头帧拼成封面'

/** 等待审批时轮次仍为运行态，工具调用关联待处理交互。 */
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

/** 在读取规范与出图之间插入正文，阻止连续工具合并为活动组。 */
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

const pendingApproval = {
  interactionId: APPROVAL_INTERACTION_ID,
  interactionKind: 'approval',
  state: 'pending',
  toolCallId: APPROVAL_TOOL_CALL_ID,
}

const delegateCard = (
  toolCallId: string,
  childId: string,
  stepId: string,
  state: 'running' | 'done',
) => ({
  agentRefs: [{ agentId: childId, role: 'child' }],
  display: { agent_name: MOCK_CHILD_AGENT, kind: 'agent_call', prompt: MOCK_CHILD_TASK },
  frameId: `${stepId}.${toolCallId}`,
  kind: 'tool',
  name: 'delegate_task',
  ...(state === 'done' ? { output: MOCK_CHILD_REPLY } : {}),
  state,
  toolCallId,
})

const childTurn = (childId: string) => {
  const child = children.get(childId) ?? { done: false, text: '' }
  return {
    content: [{ text: MOCK_CHILD_TASK, type: 'text' }],
    kind: 'turn',
    ordinal: 1,
    origin: { kind: 'user' },
    startedAt: '2026-08-31T02:00:00Z',
    state: child.done ? 'completed' : 'running',
    ...(child.done ? { durationMs: 6400, endedAt: '2026-08-31T02:00:06Z' } : {}),
    steps: [
      {
        frames: [
          { frameId: 't1.1.f1', kind: 'thinking', text: '先定每一镜的景别。' },
          ...(child.text === ''
            ? []
            : [{ frameId: 't1.1.f2', kind: 'text', role: 'assistant', text: child.text }]),
        ],
        kind: 'step',
        ordinal: 1,
        startedAt: '2026-08-31T02:00:00Z',
        state: child.done ? 'completed' : 'running',
        stepId: 't1.1',
        turnId: 't1',
      },
    ],
    turnId: 't1',
  }
}

/** 子代理那一页：只有它自己的 t1；名册与主页同一份。 */
export const mockChildPage = (conversationId: string, childId: string) => ({
  agent_id: childId,
  agents: [
    { agentId: 'main', type: 'main' },
    { agentId: childId, label: MOCK_CHILD_AGENT, parentAgentId: 'main', type: 'sub' },
  ],
  has_more: false,
  interactions: [],
  items: [childTurn(childId)],
  meta: { activity: children.get(childId)?.done === false ? 'turn' : 'idle' },
  pending_interactions: [],
  prompts: [],
  seq: seqOf.get(streamKey(conversationId, childId)) ?? HISTORY_SEQ,
  tasks: [],
  title: '',
  todos: [],
})

/** 为待审批会话追加固定审批轮；未传 ID 时返回普通历史。 */
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
    // 页里只有历史那几轮，水位也停在历史处；之后的都从日志补，页与水位才对得上。
    seq: HISTORY_SEQ,
    tasks: [],
    title: '夜景延时素材生成',
    todos: [],
  }
}

const historyTurn = (ordinal: number) => ({
  durationMs: 4200,
  endedAt: '2026-08-31T02:00:0'.concat(String(ordinal), 'Z'),
  kind: 'turn',
  ordinal,
  origin: { kind: 'user' },
  // 将参考图置于两段文字之间，验证 part 顺序。
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
  triggerPromptId: `p_t${ordinal}`,
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
              delegateCard(MOCK_HISTORY_DELEGATE_CALL, MOCK_HISTORY_CHILD, `t${ordinal}.1`, 'done'),
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

export const transcriptHandlers = [
  http.get('*/api/conversations/:conversationId/transcript', ({ params, request }) => {
    const conversationId = String(params['conversationId'])
    const agentId = new URL(request.url).searchParams.get('agent_id') ?? 'main'
    if (agentId === 'main') return HttpResponse.json(mockTranscriptPage(conversationId))
    if (!children.has(agentId)) {
      return HttpResponse.json({ detail: '这段对话里没有这个 agent' }, { status: 404 })
    }
    return HttpResponse.json(mockChildPage(conversationId, agentId))
  }),

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

  // 返回 since 之后的日志批次；固定历史基线之外的内容依赖此端点补齐。
  http.get('*/api/conversations/:conversationId/transcript/ops', ({ params, request }) => {
    const conversationId = String(params['conversationId'])
    const query = new URL(request.url).searchParams
    const since = Number(query.get('since_seq') ?? 0)
    const agentId = query.get('agent_id') ?? 'main'
    const key = streamKey(conversationId, agentId)
    const log = logOf.get(key) ?? []
    return HttpResponse.json({
      agent_id: agentId,
      batches: log.filter((batch) => batch.seq > since),
      complete: true,
      latest_seq: seqOf.get(key) ?? HISTORY_SEQ,
    })
  }),

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

  // path-to-regexp 不支持 :promptId:abort，使用通配路由后自行解析 ID。
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

    // 结束事件广播到所有连接，侧栏据此刷新 lastRunId。
    setTimeout(() => {
      for (const conversation of justFinished) {
        conversation.lastRunId = crypto.randomUUID()
        client.send(
          JSON.stringify({
            payload: { busy: false, last_turn_reason: 'completed', pending_interaction: 'none' },
            session_id: conversation.id,
            type: 'event.session.work_changed',
          }),
        )
      }
    }, WORK_DONE_DELAY_MS)

    let joined: Connection | null = null
    // 按连接去重文件更新计划，避免 StrictMode 重订造成重复版本递增。
    const fsScheduled = new Set<string>()
    client.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return
      const frame = JSON.parse(event.data) as {
        id?: string
        payload?: {
          agent_ids?: string[]
          paths?: string[]
          session_id?: string
          transcript?: Record<string, string>
        }
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

      if (frame.type === 'unsubscribe_v2') {
        const agentIds = frame.payload?.agent_ids ?? []
        if (agentIds.length === 0) joined?.agents.clear()
        for (const agentId of agentIds) joined?.agents.delete(agentId)
        client.send(JSON.stringify({ id: frame.id, type: 'ack' }))
        return
      }

      if (frame.type !== 'subscribe_v2') return
      const conversationId = frame.payload?.session_id ?? ''
      // 表里每个 agent 各回一帧 reset；不属于这段对话的子代理整帧拒绝，与后端一致。
      const agentIds = Object.keys(frame.payload?.transcript ?? { main: 'delta' })
      if (agentIds.some((agentId) => agentId !== 'main' && !children.has(agentId))) {
        client.send(
          JSON.stringify({ code: 404, id: frame.id, msg: 'agent not in session', type: 'ack' }),
        )
        return
      }
      client.send(
        JSON.stringify({ id: frame.id, payload: { accepted: [conversationId] }, type: 'ack' }),
      )
      for (const agentId of agentIds) {
        client.send(
          JSON.stringify({
            payload: {
              agent_id: agentId,
              has_more_older: true,
              seq: seqOf.get(streamKey(conversationId, agentId)) ?? HISTORY_SEQ,
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
      }
      const first = joined === null
      joined ??= {
        agents: new Set<string>(),
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
      for (const agentId of agentIds) joined.agents.add(agentId)
      if (!first) return
      connections.add(joined)
      // 普通订阅自动启动演示运行，待审批会话保持等待。
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

const broadcast = (conversationId: string, ops: Batch, agentId = 'main') => {
  const key = streamKey(conversationId, agentId)
  const seq = (seqOf.get(key) ?? HISTORY_SEQ) + 1
  seqOf.set(key, seq)
  logOf.set(key, [...(logOf.get(key) ?? []), { ops, seq }])
  const payload = { agent_id: agentId, ops, seq }
  for (const connection of connections) {
    if (connection.conversationId === conversationId && connection.agents.has(agentId)) {
      connection.send(payload)
    }
  }
}

type Lazy = Batch | (() => Batch)

/** 不带 agent 的批次走主流；子代理流的批次点名 agent。 */
type Scheduled = Lazy | { agent: string; ops: Lazy }

const resolve = (item: Scheduled): [string, Batch] => {
  if (!Array.isArray(item) && typeof item !== 'function') {
    return [item.agent, typeof item.ops === 'function' ? item.ops() : item.ops]
  }
  return ['main', typeof item === 'function' ? item() : item]
}

/** 记录批次定时器以支持取消；函数批次在发送时求值。 */
const schedule = (conversationId: string, batches: Scheduled[], done?: () => void) => {
  const handles = batches.map((item, index) =>
    setTimeout(
      () => {
        const [agentId, ops] = resolve(item)
        broadcast(conversationId, ops, agentId)
      },
      BEAT_MS * (index + 1),
    ),
  )
  handles.push(setTimeout(() => done?.(), BEAT_MS * (batches.length + 1)))
  timers.set(conversationId, [...(timers.get(conversationId) ?? []), ...handles])
}

/** 取消未发批次，终止当前轮后继续队列。 */
const stopTurn = (conversationId: string) => {
  for (const handle of timers.get(conversationId) ?? []) clearTimeout(handle)
  timers.delete(conversationId)
  const active = running.get(conversationId)
  running.delete(conversationId)
  if (active === undefined) return
  const childId = `${active.turnId}-child`
  const child = children.get(childId)
  if (child !== undefined && !child.done) {
    // 父被停，子代理随之停：它那条流也收成 cancelled。
    children.set(childId, { ...child, done: true })
    broadcast(
      conversationId,
      [
        {
          op: 'turn.upsert',
          turn: {
            content: [{ text: MOCK_CHILD_TASK, type: 'text' }],
            endedAt: new Date().toISOString(),
            kind: 'turn',
            ordinal: 1,
            origin: { kind: 'user' },
            state: 'cancelled',
            turnId: 't1',
          },
        },
        { meta: { activity: 'idle' }, op: 'meta.merge' },
      ],
      childId,
    )
  }
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
        triggerPromptId: active.promptId,
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

/** 按审批决定结束交互、工具和轮次，再继续队列。 */
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

const drain = (conversationId: string) => {
  const queue = queues.get(conversationId) ?? []
  const next = queue.shift()
  queues.set(conversationId, queue)
  if (next !== undefined) playTurn(conversationId, next)
}

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
        promptIds: [prompt.promptId],
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
  // 相邻的读取与写入调用用于验证活动组聚合。
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
      triggerPromptId: prompt.promptId,
      turnId,
      ...(state === 'completed'
        ? {
            endedAt: new Date().toISOString(),
            usage: { cachedTokens: 3080, inputTokens: 8230, outputTokens: 964 },
          }
        : {}),
    },
  })

  // 演示运行派一个子代理：它那条流边跑边填，面板打开时能看到进度。
  const childId = `${turnId}-child`
  const delegateCallId = `${turnId}-delegate`
  children.set(childId, { done: false, text: '' })
  const childSays = (text: string, done: boolean) => (): Batch => {
    children.set(childId, { done, text })
    return [
      {
        op: 'frame.upsert',
        frame: { frameId: 't1.1.f2', kind: 'text', role: 'assistant', text },
        stepId: 't1.1',
        turnId: 't1',
      },
      ...(done
        ? [
            {
              op: 'step.upsert',
              step: {
                endedAt: new Date().toISOString(),
                kind: 'step',
                ordinal: 1,
                startedAt: now,
                state: 'completed',
                stepId: 't1.1',
                turnId: 't1',
              },
              turnId: 't1',
            },
            {
              op: 'turn.upsert',
              turn: {
                content: [{ text: MOCK_CHILD_TASK, type: 'text' }],
                durationMs: BEAT_MS * 3,
                endedAt: new Date().toISOString(),
                kind: 'turn',
                ordinal: 1,
                origin: { kind: 'user' },
                startedAt: now,
                state: 'completed',
                turnId: 't1',
              },
            },
            { meta: { activity: 'idle' }, op: 'meta.merge' },
          ]
        : []),
    ]
  }

  // 首批立即发送并写入日志，订阅未就绪时仍可补发；开场输入存于轮头部，user frame 仅用于追加。
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
          frame: delegateCard(delegateCallId, childId, stepId, 'running'),
          op: 'frame.upsert',
          stepId,
          turnId,
        },
      ],
      {
        agent: childId,
        ops: [
          {
            op: 'turn.upsert',
            turn: {
              content: [{ text: MOCK_CHILD_TASK, type: 'text' }],
              kind: 'turn',
              ordinal: 1,
              origin: { kind: 'user' },
              startedAt: now,
              state: 'running',
              turnId: 't1',
            },
          },
          { meta: { activity: 'turn' }, op: 'meta.merge' },
          {
            op: 'step.upsert',
            step: {
              kind: 'step',
              ordinal: 1,
              startedAt: now,
              state: 'running',
              stepId: 't1.1',
              turnId: 't1',
            },
            turnId: 't1',
          },
          {
            op: 'frame.upsert',
            frame: { frameId: 't1.1.f1', kind: 'thinking', text: '先定每一镜的景别。' },
            stepId: 't1.1',
            turnId: 't1',
          },
        ],
      },
      { agent: childId, ops: childSays('S3-1 特写：鞋头压过水面；', false) },
      { agent: childId, ops: childSays(MOCK_CHILD_REPLY, true) },
      [
        {
          frame: delegateCard(delegateCallId, childId, stepId, 'done'),
          op: 'frame.upsert',
          stepId,
          turnId,
        },
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
