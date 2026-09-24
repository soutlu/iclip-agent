import { http, HttpResponse } from 'msw'
import type { z } from 'zod'
import {
  zConversationIn,
  zTaskCreateIn,
  zTaskIn,
  zTaskInputsOutput,
  type zTaskOut,
} from '@/shared/api/generated/zod.gen'
import { PERMISSION } from '@/shared/auth/permissions'
import { auditHandlers } from './audit'
import { mockAuthUser, mockGovernor } from './auth-user'
import {
  addMockCollection,
  addMockConversation,
  liveMockConversation,
  mockCollections,
  mockConversations,
  resetMockConversations,
  type MockConversation,
} from './conversations'
import { byCreatedDesc, mockCreatedAt, pageByCreated } from './paging'
import { transcriptHandlers } from './transcript'
import { workspaceHandlers } from './workspace'

// MSW handlers 由单测与 dev:mock 共用；普通 dev 不注册。响应字段以 contract/openapi.json 为准。

export {
  addMockCollection,
  addMockConversation,
  liveMockConversation,
  mockAuthUser,
  mockCollections,
  mockConversations,
  mockGovernor,
  resetMockConversations,
}

export type MockUser = typeof mockAuthUser

// 登录的是谁由登录接口或单测的 loginAs 决定：governor 是治理者，其余用户名都是测试用户；页面刷新和单测清理后重置为未登录。
let currentUser: MockUser | null = null

/**
 * 单测的登录态：直接把 mock 会话设成这个用户，`/users/me`、按属主过滤的列表与认领都认它，退出登录照常清掉。
 * overrides 换权限等字段；返回实际登录的用户。
 */
export const loginAs = (user: MockUser, overrides: Partial<MockUser> = {}): MockUser => {
  currentUser = { ...user, ...overrides }
  return currentUser
}

/** 列表按属主过滤时用的身份；没登录就调列表接口的 API 测试按测试用户算。 */
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

/** 登录人自己还活着的对话；工作台接口只列这些，墓碑只进审计。 */
const mine = () =>
  mockConversations.filter((item) => item.ownerUserId === activeUserId() && item.deletedAt === null)

/** done / open 看 completedAt，running 含待审批；计数用相同筛选。 */
const inState = (item: MockConversation, state: string | null) => {
  if (state === 'running') return item.activity.busy
  if (state === 'done') return item.completedAt !== null
  if (state === 'open') return item.completedAt === null
  return true
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
  const now = mockCreatedAt()
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
    permissions: [PERMISSION.agentRead, PERMISSION.agentRun],
    roles: ['editor'],
    username: id.slice(0, 8),
  }
  mockUsers.push(user)
  return user
}

export const resetMockUsers = () => {
  mockUsers.length = 0
}

/** 删没删、属主、需求单与时间先切出范围，state 再在范围内挑；runningTotal 只看范围。时间窗作用在 createdAt 上。 */
const auditScope = (query: URLSearchParams) => {
  const deleted = query.get('deleted') ?? 'live'
  const owner = query.get('ownerUserId')
  const taskId = query.get('taskId')
  const since = query.get('since')
  const until = query.get('until')
  return mockConversations.filter(
    (item) =>
      (deleted === 'all' || (item.deletedAt !== null) === (deleted === 'deleted')) &&
      (owner === null || item.ownerUserId === owner) &&
      (taskId === null || item.taskId === taskId) &&
      (since === null || Date.parse(item.createdAt) >= Date.parse(since)) &&
      (until === null || Date.parse(item.createdAt) <= Date.parse(until)),
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
      ...pageByCreated(rows, query.get('cursor'), limit),
      runningTotal: scoped.filter((item) => item.activity.busy).length,
      total: rows.length,
    })
  }),

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
  // 模拟 ILIKE 的大小写不敏感标题搜索。
  http.get('*/api/conversations/search', ({ request }) => {
    const keyword = (new URL(request.url).searchParams.get('q') ?? '').trim().toLowerCase()
    const items = mine()
      .sort(byCreatedDesc)
      .filter((item) => !keyword || item.title.toLowerCase().includes(keyword))
    return HttpResponse.json({ items })
  }),

  http.get('*/api/conversations/by-task/:taskId', ({ params }) =>
    HttpResponse.json({
      items: mine()
        .filter((item) => item.taskId === params['taskId'])
        .sort(byCreatedDesc),
    }),
  ),

  // 列表按 createdAt 倒序、游标是 createdAt|id（合同 §3）；前端将游标视为不透明值。
  http.get('*/api/conversations', ({ request }) => {
    const state = new URL(request.url).searchParams.get('state')
    const rows = mine().filter((item) => inState(item, state))
    const ungrouped = rows.filter((item) => item.collectionId === null)
    return HttpResponse.json({
      collections: [...mockCollections].sort(byCreatedDesc).map((collection) => {
        const inside = rows.filter((item) => item.collectionId === collection.id)
        return {
          conversationCount: inside.length,
          id: collection.id,
          name: collection.name,
          page: pageByCreated(inside, null, SIDEBAR_PER_COLLECTION),
          updatedAt: collection.updatedAt,
        }
      }),
      ungrouped: pageByCreated(ungrouped, null, SIDEBAR_UNGROUPED),
      ungroupedCount: ungrouped.length,
    })
  }),

  // 带 id 重发答复已有那一段；墓碑的 id 不能再用（合同 §6）。
  http.post('*/api/conversations', async ({ request }) => {
    const body = zConversationIn.parse(await request.json())
    const existing = mockConversations.find((item) => item.id === body.id)
    if (existing?.deletedAt) {
      return HttpResponse.json({ detail: '没有这段对话' }, { status: 404 })
    }
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
    const rows = mine().filter(
      (item) => item.collectionId === null && inState(item, query.get('state')),
    )
    return HttpResponse.json(pageByCreated(rows, query.get('cursor'), SIDEBAR_UNGROUPED))
  }),

  http.get('*/api/conversations/by-collection/:collectionId', ({ params, request }) => {
    const query = new URL(request.url).searchParams
    const rows = mine().filter(
      (item) => item.collectionId === params['collectionId'] && inState(item, query.get('state')),
    )
    return HttpResponse.json(pageByCreated(rows, query.get('cursor'), SIDEBAR_PER_COLLECTION))
  }),

  http.put('*/api/conversations/:conversationId/collection', async ({ params, request }) => {
    const conversation = liveMockConversation(String(params['conversationId']))
    if (!conversation) return HttpResponse.json({ detail: '没有这段对话' }, { status: 404 })
    const body = (await request.json()) as { collectionId: string | null }
    Object.assign(conversation, {
      collectionId: body.collectionId,
      updatedAt: new Date().toISOString(),
    })
    return HttpResponse.json({ conversation })
  }),

  http.put('*/api/conversations/:conversationId/task', async ({ params, request }) => {
    const conversation = liveMockConversation(String(params['conversationId']))
    if (!conversation) return HttpResponse.json({ detail: '没有这段对话' }, { status: 404 })
    const body = (await request.json()) as { taskId: string | null }
    Object.assign(conversation, { taskId: body.taskId, updatedAt: new Date().toISOString() })
    return HttpResponse.json({ conversation })
  }),

  http.put('*/api/conversations/:conversationId/completion', async ({ params, request }) => {
    const conversation = liveMockConversation(String(params['conversationId']))
    if (!conversation) return HttpResponse.json({ detail: '没有这段对话' }, { status: 404 })
    const body = (await request.json()) as { completed: boolean }
    const now = new Date().toISOString()
    Object.assign(conversation, {
      completedAt: body.completed ? now : null,
      updatedAt: now,
    })
    return HttpResponse.json({ conversation })
  }),

  http.patch('*/api/conversations/:conversationId', async ({ params, request }) => {
    const conversation = liveMockConversation(String(params['conversationId']))
    if (!conversation) return HttpResponse.json({ detail: '没有这段对话' }, { status: 404 })
    const body = (await request.json()) as { title: string }
    Object.assign(conversation, { title: body.title, updatedAt: new Date().toISOString() })
    return HttpResponse.json({ conversation })
  }),

  // 删除留下墓碑：行还在，deletedAt 记下时刻，审计的 deleted 筛选列得出它（合同 §6）。
  http.delete('*/api/conversations/:conversationId', ({ params }) => {
    const conversation = liveMockConversation(String(params['conversationId']))
    if (!conversation) return HttpResponse.json({ detail: '没有这段对话' }, { status: 404 })
    const now = new Date().toISOString()
    Object.assign(conversation, { deletedAt: now, updatedAt: now })
    return new HttpResponse(null, { status: 204 })
  }),

  http.get('*/api/collections', () =>
    HttpResponse.json({ items: [...mockCollections].sort(byCreatedDesc) }),
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

  // 与对话列表同一条排序键（合同 §3）：建立时间倒序，游标是上一页末行的「时刻|id」。
  http.get('*/api/tasks', ({ request }) => {
    const url = new URL(request.url)
    let items: MockTask[] = mockTasks
    if (url.searchParams.get('claimedBy') === 'me') {
      items = items.filter((task) => task.assigneeUserIds.includes(activeUserId()))
    }
    const status = url.searchParams.get('status')
    if (status) items = items.filter((task) => task.status === status)
    const ids = url.searchParams.getAll('ids')
    if (ids.length > 0) items = items.filter((task) => ids.includes(task.id))
    const limit = Number(url.searchParams.get('limit') ?? 20)
    return HttpResponse.json({
      ...pageByCreated(items, url.searchParams.get('cursor'), limit),
      total: items.length,
    })
  }),

  http.post('*/api/tasks', async ({ request }) => {
    const parsed = zTaskCreateIn.safeParse(await request.json())
    if (!parsed.success) return HttpResponse.json({ detail: '需求单参数不合法' }, { status: 422 })
    const now = mockCreatedAt()
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
    if (!task.assigneeUserIds.includes(activeUserId())) {
      task.assigneeUserIds.push(activeUserId())
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

  ...auditHandlers,
]
