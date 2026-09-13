import { http, HttpResponse } from 'msw'
import type { z } from 'zod'
import {
  zConversationIn,
  zTaskCreateIn,
  zTaskIn,
  zTaskInputsOutput,
  type zTaskOut,
} from '@/shared/api/generated/zod.gen'
import { mockAuthUser, mockGovernor } from './auth-user'
import {
  addMockCollection,
  addMockConversation,
  mockCollections,
  mockConversations,
  resetMockConversations,
  type MockConversation,
} from './conversations'
import { transcriptHandlers } from './transcript'
import { workspaceHandlers } from './workspace'

// MSW handlers 由单测与 dev:mock 共用；普通 dev 不注册。响应字段以 contract/openapi.json 为准。

export {
  addMockCollection,
  addMockConversation,
  mockAuthUser,
  mockCollections,
  mockConversations,
  mockGovernor,
  resetMockConversations,
}

type MockUser = typeof mockAuthUser

// 登录的是谁由登录接口决定：governor 是治理者，其余用户名都是测试用户；页面刷新和单测清理后重置为未登录。
let currentUser: MockUser | null = null

/** 列表按属主过滤时用的身份；单测常用 server.use 直接给 /users/me 答复而不走登录，此时按测试用户算。 */
const activeUserId = () => (currentUser ?? mockAuthUser).id

// 按 assetId 记录签名时的 contentType，登记响应复用此信息。
const mockUploads = new Map<string, string>()
const mockUploadBytes = new Map<string, { body: ArrayBuffer; contentType: string }>()

export const resetMockSession = () => {
  currentUser = null
  mockUploads.clear()
  mockUploadBytes.clear()
}

const SIDEBAR_PER_COLLECTION = 10
const SIDEBAR_UNGROUPED = 20

/** 登录人自己的对话；工作台接口只列这些。 */
const mine = () => mockConversations.filter((item) => item.ownerUserId === activeUserId())

const byRecent = (a: MockConversation, b: MockConversation) =>
  b.updatedAt.localeCompare(a.updatedAt)

const pageOf = (rows: MockConversation[], limit: number) => {
  const items = rows.slice(0, limit)
  const last = items[items.length - 1]
  return {
    items,
    nextCursor: items.length === limit && last ? `${last.updatedAt}|${last.id}` : null,
  }
}

/** 筛选与后端一致：running 包含待审批，done 要求已结束且至少运行过一轮；计数使用相同筛选。 */
const inState = (item: MockConversation, state: string | null) => {
  if (state === 'running') return item.activity.busy
  if (state === 'done') return !item.activity.busy && item.activity.lastTurnReason !== null
  return true
}

const after = (rows: MockConversation[], cursor: string | null) => {
  if (!cursor) return rows
  const index = rows.findIndex((item) => `${item.updatedAt}|${item.id}` === cursor)
  return index < 0 ? rows : rows.slice(index + 1)
}

type MockTask = z.output<typeof zTaskOut>

/** 模拟后端在请求默认值补齐后输出完整的 inputs。 */
const completeTaskInputs = (inputs: z.output<typeof zTaskCreateIn>['inputs']) =>
  zTaskInputsOutput.parse({
    ...inputs,
    products: inputs.products.map((product) => ({ image_oss_urls: [], ...product })),
    reference_image_oss_urls: {
      model: [],
      outfit: [],
      prop: [],
      ...inputs.reference_image_oss_urls,
    },
    reference_video_oss_url: inputs.reference_video_oss_url ?? null,
    video_spec: { aspect_ratio: null, duration_seconds: null, ...inputs.video_spec },
  })

export const mockTasks: MockTask[] = []

export const addMockTask = (title: string) => {
  const now = new Date().toISOString()
  const task: MockTask = {
    assigneeUserIds: [],
    inputs: zTaskInputsOutput.parse({
      video_spec: { aspect_ratio: null, duration_seconds: null },
      reference_video_oss_url: null,
      products: [{ style_no: 'SBPU24001W', image_oss_urls: [] }],
      reference_image_oss_urls: { model: [], outfit: [], prop: [] },
    }),
    createdAt: now,
    creatorUserId: mockAuthUser.id,
    deadline: null,
    id: crypto.randomUUID(),
    priority: 0,
    status: 'draft',
    title,
    updatedAt: now,
  }
  mockTasks.push(task)
  return task
}

export const resetMockTasks = () => {
  mockTasks.length = 0
}

/** 名册里两个登录账号之外的其他人；治理视图用它把 ownerUserId 翻成名字。 */
export const mockUsers: MockUser[] = []

export const addMockUser = (displayName: string, id = crypto.randomUUID()) => {
  const user: MockUser = {
    ...mockAuthUser,
    displayName,
    email: `${id.slice(0, 8)}@example.com`,
    id,
    permissions: ['agent:read', 'agent:run'],
    roles: ['editor'],
    username: id.slice(0, 8),
  }
  mockUsers.push(user)
  return user
}

export const resetMockUsers = () => {
  mockUsers.length = 0
}

/** 属主、需求单与时间三个筛选先切出范围，state 再在范围内挑；runningTotal 只看范围。 */
const auditScope = (query: URLSearchParams) => {
  const owner = query.get('ownerUserId')
  const taskId = query.get('taskId')
  const since = query.get('since')
  const until = query.get('until')
  return [...mockConversations]
    .sort(byRecent)
    .filter(
      (item) =>
        (owner === null || item.ownerUserId === owner) &&
        (taskId === null || item.taskId === taskId) &&
        (since === null || item.updatedAt >= since) &&
        (until === null || item.updatedAt <= until),
    )
}

export const handlers = [
  // /users/me 是会话事实源，未登录时返回 401。
  http.get('*/api/users/me', () =>
    currentUser
      ? HttpResponse.json({ user: currentUser })
      : new HttpResponse(null, { status: 401 }),
  ),

  // 登录是 OAuth2 表单（username / password），不是 JSON。
  http.post('*/api/auth/login', async ({ request }) => {
    const form = new URLSearchParams(await request.text())
    currentUser = form.get('username') === mockGovernor.username ? mockGovernor : mockAuthUser
    return new HttpResponse(null, { status: 204 })
  }),

  http.post('*/api/auth/logout', () => {
    currentUser = null
    return new HttpResponse(null, { status: 204 })
  }),

  // mock 不启用 SSO，以 404 表示路由未挂载。
  http.get('*/api/auth/sso/authorize', () => new HttpResponse(null, { status: 404 })),

  // 两个登录账号在前，其余按加入顺序，按名册接口分页。
  http.get('*/api/users', ({ request }) => {
    const query = new URL(request.url).searchParams
    const page = Number(query.get('page') ?? 1)
    const pageSize = Number(query.get('pageSize') ?? 200)
    const items = [mockAuthUser, mockGovernor, ...mockUsers]
    return HttpResponse.json({
      items: items.slice((page - 1) * pageSize, page * pageSize),
      page,
      pageSize,
      total: items.length,
    })
  }),

  // 治理者的全平台列表：两个总数不随翻页变，state 用与侧栏同一口径。
  http.get('*/api/conversations/audit', ({ request }) => {
    const query = new URL(request.url).searchParams
    const scoped = auditScope(query)
    const rows = scoped.filter((item) => inState(item, query.get('state')))
    const limit = Number(query.get('limit') ?? 20)
    return HttpResponse.json({
      ...pageOf(after(rows, query.get('cursor')), limit),
      runningTotal: scoped.filter((item) => item.activity.busy).length,
      total: rows.length,
    })
  }),

  // 模拟 ILIKE 的大小写不敏感标题搜索，按最近活动排序。
  http.get('*/api/conversations/agents', () =>
    HttpResponse.json({
      items: [
        { id: 'storyboard', name: '分镜 Agent' },
        { id: 'replica', name: '完全复刻' },
      ],
      default: 'storyboard',
    }),
  ),

  // 侧栏、搜索与分页都只列自己的对话，治理者也一样（合同 §6）；全平台的走 audit。
  http.get('*/api/conversations/search', ({ request }) => {
    const keyword = (new URL(request.url).searchParams.get('q') ?? '').trim().toLowerCase()
    const items = mine()
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .filter((item) => !keyword || item.title.toLowerCase().includes(keyword))
    return HttpResponse.json({ items })
  }),

  // 分页游标使用 updatedAt|id；前端将其视为不透明值。
  http.get('*/api/conversations', ({ request }) => {
    const state = new URL(request.url).searchParams.get('state')
    const sorted = mine()
      .sort(byRecent)
      .filter((item) => inState(item, state))
    const ungrouped = sorted.filter((item) => item.collectionId === null)
    return HttpResponse.json({
      collections: [...mockCollections]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map((collection) => {
          const inside = sorted.filter((item) => item.collectionId === collection.id)
          return {
            conversationCount: inside.length,
            id: collection.id,
            name: collection.name,
            page: pageOf(inside, SIDEBAR_PER_COLLECTION),
            updatedAt: collection.updatedAt,
          }
        }),
      ungrouped: pageOf(ungrouped, SIDEBAR_UNGROUPED),
      ungroupedCount: ungrouped.length,
    })
  }),

  http.post('*/api/conversations', async ({ request }) => {
    const body = zConversationIn.parse(await request.json())
    const existing = mockConversations.find((item) => item.id === body.id)
    if (existing) return HttpResponse.json({ conversation: existing })
    const conversation = addMockConversation(body.title ?? '新对话', undefined, activeUserId())
    if (body.id) conversation.id = body.id
    conversation.agentId = body.agentId
    conversation.taskId = body.taskId ?? null
    conversation.collectionId = body.collectionId ?? null
    return HttpResponse.json({ conversation }, { status: 201 })
  }),

  http.get('*/api/conversations/ungrouped', ({ request }) => {
    const query = new URL(request.url).searchParams
    const rows = mine()
      .sort(byRecent)
      .filter((item) => item.collectionId === null && inState(item, query.get('state')))
    return HttpResponse.json(pageOf(after(rows, query.get('cursor')), SIDEBAR_UNGROUPED))
  }),

  http.get('*/api/conversations/by-collection/:collectionId', ({ params, request }) => {
    const query = new URL(request.url).searchParams
    const rows = mine()
      .sort(byRecent)
      .filter(
        (item) => item.collectionId === params['collectionId'] && inState(item, query.get('state')),
      )
    return HttpResponse.json(pageOf(after(rows, query.get('cursor')), SIDEBAR_PER_COLLECTION))
  }),

  http.put('*/api/conversations/:conversationId/collection', async ({ params, request }) => {
    const conversation = mockConversations.find((item) => item.id === params['conversationId'])
    if (!conversation) return HttpResponse.json({ detail: '没有这段对话' }, { status: 404 })
    const body = (await request.json()) as { collectionId: string | null }
    Object.assign(conversation, {
      collectionId: body.collectionId,
      updatedAt: new Date().toISOString(),
    })
    return HttpResponse.json({ conversation })
  }),

  http.put('*/api/conversations/:conversationId/task', async ({ params, request }) => {
    const conversation = mockConversations.find((item) => item.id === params['conversationId'])
    if (!conversation) return HttpResponse.json({ detail: '没有这段对话' }, { status: 404 })
    const body = (await request.json()) as { taskId: string | null }
    Object.assign(conversation, { taskId: body.taskId, updatedAt: new Date().toISOString() })
    return HttpResponse.json({ conversation })
  }),

  http.patch('*/api/conversations/:conversationId', async ({ params, request }) => {
    const conversation = mockConversations.find((item) => item.id === params['conversationId'])
    if (!conversation) return HttpResponse.json({ detail: '没有这段对话' }, { status: 404 })
    const body = (await request.json()) as { title: string }
    Object.assign(conversation, { title: body.title, updatedAt: new Date().toISOString() })
    return HttpResponse.json({ conversation })
  }),

  http.delete('*/api/conversations/:conversationId', ({ params }) => {
    const index = mockConversations.findIndex((item) => item.id === params['conversationId'])
    if (index < 0) return HttpResponse.json({ detail: '没有这段对话' }, { status: 404 })
    mockConversations.splice(index, 1)
    return new HttpResponse(null, { status: 204 })
  }),

  http.get('*/api/collections', () =>
    HttpResponse.json({
      items: [...mockCollections].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    }),
  ),

  http.post('*/api/collections', async ({ request }) => {
    const body = (await request.json()) as { name: string }
    return HttpResponse.json({ collection: addMockCollection(body.name) }, { status: 201 })
  }),

  http.patch('*/api/collections/:collectionId', async ({ params, request }) => {
    const collection = mockCollections.find((item) => item.id === params['collectionId'])
    if (!collection) return HttpResponse.json({ detail: '没有这个合集' }, { status: 404 })
    const body = (await request.json()) as { name: string }
    Object.assign(collection, { name: body.name, updatedAt: new Date().toISOString() })
    return HttpResponse.json({ collection })
  }),

  http.delete('*/api/collections/:collectionId', ({ params }) => {
    const index = mockCollections.findIndex((item) => item.id === params['collectionId'])
    if (index < 0) return HttpResponse.json({ detail: '没有这个合集' }, { status: 404 })
    const [removed] = mockCollections.splice(index, 1)
    mockConversations.forEach((item) => {
      if (item.collectionId === removed?.id) item.collectionId = null
    })
    return new HttpResponse(null, { status: 204 })
  }),

  http.get('*/api/tasks', ({ request }) => {
    const url = new URL(request.url)
    let items = [...mockTasks]
    if (url.searchParams.get('claimedBy') === 'me') {
      items = items.filter((task) => task.assigneeUserIds.includes(mockAuthUser.id))
    }
    const status = url.searchParams.get('status')
    if (status) items = items.filter((task) => task.status === status)
    return HttpResponse.json({ items })
  }),

  http.post('*/api/tasks', async ({ request }) => {
    const parsed = zTaskCreateIn.safeParse(await request.json())
    if (!parsed.success) return HttpResponse.json({ detail: '需求单参数不合法' }, { status: 422 })
    const now = new Date().toISOString()
    const task: MockTask = {
      ...parsed.data,
      deadline: parsed.data.deadline ?? null,
      inputs: completeTaskInputs(parsed.data.inputs),
      assigneeUserIds: [],
      createdAt: now,
      creatorUserId: mockAuthUser.id,
      id: crypto.randomUUID(),
      status: 'draft',
      updatedAt: now,
    }
    mockTasks.unshift(task)
    return HttpResponse.json({ task }, { status: 201 })
  }),

  http.get('*/api/tasks/:taskId', ({ params }) => {
    const task = mockTasks.find((item) => item.id === params['taskId'])
    return task
      ? HttpResponse.json({ task })
      : HttpResponse.json({ detail: '没有这张需求单' }, { status: 404 })
  }),

  http.put('*/api/tasks/:taskId', async ({ params, request }) => {
    const task = mockTasks.find((item) => item.id === params['taskId'])
    if (!task) return HttpResponse.json({ detail: '没有这张需求单' }, { status: 404 })
    const parsed = zTaskIn.safeParse(await request.json())
    if (!parsed.success) return HttpResponse.json({ detail: '需求单参数不合法' }, { status: 422 })
    Object.assign(task, parsed.data, {
      inputs: completeTaskInputs(parsed.data.inputs),
      updatedAt: new Date().toISOString(),
    })
    return HttpResponse.json({ task })
  }),

  http.post('*/api/tasks/:taskId/publish', ({ params }) => {
    const task = mockTasks.find((item) => item.id === params['taskId'])
    if (!task) return HttpResponse.json({ detail: '没有这张需求单' }, { status: 404 })
    if (task.status !== 'draft') {
      return HttpResponse.json({ detail: '只有草稿能发布' }, { status: 409 })
    }
    Object.assign(task, { status: 'published', updatedAt: new Date().toISOString() })
    return HttpResponse.json({ task })
  }),

  http.post('*/api/tasks/:taskId/confirm', ({ params }) => {
    const task = mockTasks.find((item) => item.id === params['taskId'])
    if (!task) return HttpResponse.json({ detail: '没有这张需求单' }, { status: 404 })
    if (task.status !== 'published' && task.status !== 'confirmed') {
      return HttpResponse.json({ detail: '这张单认领不了' }, { status: 409 })
    }
    if (!task.assigneeUserIds.includes(mockAuthUser.id)) {
      task.assigneeUserIds.push(mockAuthUser.id)
    }
    Object.assign(task, { status: 'confirmed', updatedAt: new Date().toISOString() })
    return HttpResponse.json({ task })
  }),

  http.post('*/api/tasks/:taskId/withdraw', ({ params }) => {
    const task = mockTasks.find((item) => item.id === params['taskId'])
    if (!task) return HttpResponse.json({ detail: '没有这张需求单' }, { status: 404 })
    if (task.status !== 'published' && task.status !== 'confirmed') {
      return HttpResponse.json({ detail: '这张单撤不了' }, { status: 409 })
    }
    Object.assign(task, { status: 'withdrawn', updatedAt: new Date().toISOString() })
    return HttpResponse.json({ task })
  }),

  // 签名、直传与确认共用上传类型记录，保持确认响应与签名一致。
  http.post('*/api/uploads/sign', async ({ request }) => {
    const body = (await request.json()) as { contentType: string }
    const uploadId = crypto.randomUUID()
    mockUploads.set(uploadId, body.contentType)
    return HttpResponse.json({
      uploadId,
      upload: {
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        headers: { 'Content-Type': body.contentType },
        url: `http://localhost/mock-oss/${uploadId}`,
      },
    })
  }),

  http.put('*/mock-oss/:uploadId', async ({ params, request }) => {
    mockUploadBytes.set(String(params['uploadId']), {
      body: await request.arrayBuffer(),
      contentType: request.headers.get('Content-Type') ?? 'application/octet-stream',
    })
    return new HttpResponse(null, { status: 200 })
  }),
  http.get('*/mock-oss/:uploadId', ({ params }) => {
    const media = mockUploadBytes.get(String(params['uploadId']))
    return media
      ? new HttpResponse(media.body, { headers: { 'Content-Type': media.contentType } })
      : new HttpResponse(null, { status: 404 })
  }),

  http.post('*/api/uploads/:uploadId/confirm', ({ params }) => {
    const uploadId = params['uploadId'] as string
    const contentType = mockUploads.get(uploadId) ?? 'image/png'
    return HttpResponse.json({
      contentType,
      sizeBytes: 1024,
      url: `http://localhost/mock-oss/${uploadId}`,
    })
  }),

  ...workspaceHandlers,

  ...transcriptHandlers,
]
