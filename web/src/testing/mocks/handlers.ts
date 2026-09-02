import { http, HttpResponse } from 'msw'
import { transcriptHandlers } from './transcript'

// ─────────────────────────────────────────────────────────────────────────────
// MSW REST 契约镜像
//
//   - 单测：src/testing/setup.ts 已全局 listen / reset / close，测试里只在需要改响应时
//     `server.use(...)` 覆盖单个端点。
//   - 浏览器原型与 e2e：`pnpm dev:mock` 经 browser.ts 注册本数组；普通 `pnpm dev` 不注册。
//
// 端点形状以 contract/openapi.json 为准（响应要过生成的 zod schema），不凭印象编。
// ─────────────────────────────────────────────────────────────────────────────

/** 默认已登录用户：形状即合同 UserOut（缺一个必填字段就过不了 zUserEnvelope）。 */
export const mockAuthUser = {
  avatarUrl: '',
  city: '',
  createdAt: null,
  departments: [],
  directPermissions: [],
  displayName: '测试用户',
  email: 'tester@example.com',
  id: '0f7f4c1e-8a3b-4d0e-9c2a-6b1d2e3f4a5b',
  isActive: true,
  jobTitle: '',
  lastLoginAt: null,
  permissions: [
    'assets:read',
    'assets:write',
    'collections:read',
    'collections:write',
    'tasks:read',
    'tasks:write',
  ],
  roles: ['editor'],
  username: 'tester',
}

// 登录态是有状态的：没登录过 /users/me 就是 401，登录后才有用户——否则登录页永远直接被
// 守卫送回首页，登录旅程根本走不到。浏览器里这份状态随页面刷新归零，单测在 afterEach 归零。
let sessionActive = false

// 签名时记下的上传类型：登记回包按它给 assetType/contentType（assetId → contentType）。
const mockUploads = new Map<string, string>()

export const resetMockSession = () => {
  sessionActive = false
}

// 对话的内存存储：形状即合同 ConversationOut。搜索按标题过滤，跟后端一样不分大小写。
type MockConversation = {
  activity: {
    busy: boolean
    lastTurnReason: 'completed' | 'failed' | 'aborted' | null
    pendingInteraction: 'none' | 'approval' | 'question'
  }
  agentId: string
  collectionId: string | null
  createdAt: string
  id: string
  lastRunId: string | null
  ownerUserId: string
  taskId: string | null
  title: string
  updatedAt: string
}

export const mockConversations: MockConversation[] = []

/**
 * 往内存存储里塞一段对话，字段补全到合同形状。
 *
 * @param title - 对话标题。
 * @param updatedAt - 最近活动时刻，列表与搜索都按它倒序。
 * @returns 落库形状的对话。
 */
export const addMockConversation = (title: string, updatedAt = new Date().toISOString()) => {
  const conversation: MockConversation = {
    // 原型里没有真在跑的运行；要演行尾状态就改这一份（busy 转圈、lastTurnReason 收场）。
    activity: { busy: false, lastTurnReason: null, pendingInteraction: 'none' },
    agentId: 'storyboard',
    collectionId: null,
    createdAt: updatedAt,
    id: crypto.randomUUID(),
    lastRunId: null,
    ownerUserId: mockAuthUser.id,
    taskId: null,
    title,
    updatedAt,
  }
  mockConversations.push(conversation)
  return conversation
}

export const resetMockConversations = () => {
  mockConversations.length = 0
  mockCollections.length = 0
}

// 合集的内存存储：形状即合同 CollectionOut。
type MockCollection = {
  createdAt: string
  id: string
  name: string
  ownerUserId: string
  updatedAt: string
}

export const mockCollections: MockCollection[] = []

/**
 * 往内存存储里塞一个合集。
 *
 * @param name - 合集名字。
 * @returns 落库形状的合集。
 */
export const addMockCollection = (name: string) => {
  const now = new Date().toISOString()
  const collection: MockCollection = {
    createdAt: now,
    id: crypto.randomUUID(),
    name,
    ownerUserId: mockAuthUser.id,
    updatedAt: now,
  }
  mockCollections.push(collection)
  return collection
}

// 侧栏拓扑的截断口径照后端来：每个合集内嵌最近 10 段，没归类的给最近 20 条。
const SIDEBAR_PER_COLLECTION = 10
const SIDEBAR_UNGROUPED = 20

const byRecent = (a: MockConversation, b: MockConversation) =>
  b.updatedAt.localeCompare(a.updatedAt)

/** 一页对话：取满一页就给下一页的位置（口径同后端）。 */
const pageOf = (rows: MockConversation[], limit: number) => {
  const items = rows.slice(0, limit)
  const last = items[items.length - 1]
  return {
    items,
    nextCursor: items.length === limit && last ? `${last.updatedAt}|${last.id}` : null,
  }
}

/**
 * 列表筛选，口径同后端：`running` 是有轮次在跑（含等审批），`done` 是没在跑而且跑完过至少
 * 一轮；从没跑过的只在 `all` 里。两个数字按同一筛选算。
 */
const inState = (item: MockConversation, state: string | null) => {
  if (state === 'running') return item.activity.busy
  if (state === 'done') return !item.activity.busy && item.activity.lastTurnReason !== null
  return true
}

/** 按翻页位置切掉上一页给过的那些。 */
const after = (rows: MockConversation[], cursor: string | null) => {
  if (!cursor) return rows
  const index = rows.findIndex((item) => `${item.updatedAt}|${item.id}` === cursor)
  return index < 0 ? rows : rows.slice(index + 1)
}

// 需求单的内存存储：形状即合同 TaskOut（zTaskOut 会校验，缺字段过不了边界）。
// 测试经 server.use 覆盖单端点，或直接改这个数组后 invalidate 查询。
type MockTask = {
  assigneeUserIds: string[]
  brief: Record<string, unknown>
  createdAt: string
  creatorUserId: string
  deadline: string | null
  id: string
  priority: number
  status: string
  style: { brand: string; category: string; previewImageUrl: string; styleNo: string }
  title: string
  updatedAt: string
}

export const mockTasks: MockTask[] = []

/**
 * 往内存存储里塞一张需求单，字段补全到合同形状。
 *
 * @param title - 需求单标题。
 * @returns 落库形状的需求单。
 */
export const addMockTask = (title: string) => {
  const now = new Date().toISOString()
  const task: MockTask = {
    assigneeUserIds: [],
    brief: { referenceImages: [], referenceVideos: [], styleNos: ['SBPU24001W'] },
    createdAt: now,
    creatorUserId: mockAuthUser.id,
    deadline: null,
    id: crypto.randomUUID(),
    priority: 0,
    status: 'draft',
    style: { brand: '', category: '', previewImageUrl: '', styleNo: 'SBPU24001W' },
    title,
    updatedAt: now,
  }
  mockTasks.push(task)
  return task
}

export const resetMockTasks = () => {
  mockTasks.length = 0
}

export const handlers = [
  // ── auth（src/shared/auth/cue-auth.api.ts）─────────────────────────────
  // GET /users/me：会话唯一事实源，响应为 { user } 包装；未登录时后端返回 401。
  http.get('*/api/users/me', () =>
    sessionActive
      ? HttpResponse.json({ user: mockAuthUser })
      : new HttpResponse(null, { status: 401 }),
  ),

  // POST /auth/login：fastapi-users OAuth2 表单登录，成功 204 并种 HttpOnly cookie。
  http.post('*/api/auth/login', () => {
    sessionActive = true
    return new HttpResponse(null, { status: 204 })
  }),

  // POST /auth/logout：注销会话并清 cookie；会话本就失效时后端返回 401（前端视为成功）。
  http.post('*/api/auth/logout', () => {
    sessionActive = false
    return new HttpResponse(null, { status: 204 })
  }),

  // GET /auth/sso/authorize：mock 环境不开 SSO，后端关着时这条路由不挂载（404），登录页据此只显示账号密码。
  http.get('*/api/auth/sso/authorize', () => new HttpResponse(null, { status: 404 })),

  // ── conversations（src/features/conversations/conversations.api.ts）──────
  // GET /conversations/search：按标题搜我的对话，最近活动倒序（后端是 ILIKE，这里同样不分大小写）。
  http.get('*/api/conversations/search', ({ request }) => {
    const keyword = (new URL(request.url).searchParams.get('q') ?? '').trim().toLowerCase()
    const items = [...mockConversations]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .filter((item) => !keyword || item.title.toLowerCase().includes(keyword))
    return HttpResponse.json({ items })
  }),

  // GET /conversations：侧栏拓扑——我的合集（各带总数与第一页）+ 没归类的第一页。
  // 翻页位置照后端来：`updatedAt|id`，前端只当不透明字符串回传。
  http.get('*/api/conversations', ({ request }) => {
    const state = new URL(request.url).searchParams.get('state')
    const sorted = [...mockConversations].sort(byRecent).filter((item) => inState(item, state))
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

  // POST /conversations：新建一段对话，落进内存存储，侧栏随后重拉就能看到。
  http.post('*/api/conversations', async ({ request }) => {
    const body = (await request.json()) as { agentId: string; title?: string | null }
    const conversation = addMockConversation(body.title ?? '新对话')
    conversation.agentId = body.agentId
    return HttpResponse.json({ conversation }, { status: 201 })
  }),

  // GET /conversations/ungrouped、/by-collection/:id：往下滑加载更多。
  http.get('*/api/conversations/ungrouped', ({ request }) => {
    const query = new URL(request.url).searchParams
    const rows = [...mockConversations]
      .sort(byRecent)
      .filter((item) => item.collectionId === null && inState(item, query.get('state')))
    return HttpResponse.json(pageOf(after(rows, query.get('cursor')), SIDEBAR_UNGROUPED))
  }),

  http.get('*/api/conversations/by-collection/:collectionId', ({ params, request }) => {
    const query = new URL(request.url).searchParams
    const rows = [...mockConversations]
      .sort(byRecent)
      .filter(
        (item) => item.collectionId === params['collectionId'] && inState(item, query.get('state')),
      )
    return HttpResponse.json(pageOf(after(rows, query.get('cursor')), SIDEBAR_PER_COLLECTION))
  }),

  // PUT /conversations/:id/collection、PUT /conversations/:id/task：两处归属各一个端点。
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

  // PATCH /conversations/:id：重命名；DELETE /conversations/:id：删除。
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

  // ── collections（src/features/collections/collections.api.ts）────────────
  // 内存版合集：只列自己的，最近改动倒序；新建 / 改名 / 删除。删掉时把对话上那一列置空。
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

  // ── tasks（src/features/tasks/tasks.api.ts）──────────────────────────────
  // 内存版需求单：支持列表（含 claimedBy=me）、详情、创建、整体覆盖、发布/认领/撤回。
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
    const body = (await request.json()) as Record<string, unknown>
    const now = new Date().toISOString()
    const brief = (body['brief'] ?? {}) as Record<string, unknown>
    const styleNo = typeof body['styleNo'] === 'string' ? body['styleNo'] : ''
    const task = {
      assigneeUserIds: [],
      brief: {
        audience: '',
        color: '',
        contentType: '',
        department: '',
        durationSeconds: null,
        language: '',
        platform: '',
        purpose: '',
        referenceImages: [],
        referenceVideos: [],
        requester: '',
        requirementDescription: '',
        scene: '',
        selling: '',
        styleNos: [styleNo],
        theme: '',
        videoType: '',
        ...brief,
      },
      createdAt: now,
      creatorUserId: mockAuthUser.id,
      deadline: (body['deadline'] as string | null | undefined) ?? null,
      id: crypto.randomUUID(),
      priority: (body['priority'] as number | undefined) ?? 0,
      status: 'draft',
      style: { brand: '', category: '', previewImageUrl: '', styleNo },
      title: typeof body['title'] === 'string' ? body['title'] : '',
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
    const body = (await request.json()) as Record<string, unknown>
    Object.assign(task, {
      brief: { ...task.brief, ...(body['brief'] as object) },
      deadline: body['deadline'] as string | null,
      priority: body['priority'] as number,
      title: body['title'] as string,
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

  // ── assets 上传（src/shared/ui/composer/use-composer-attachments.ts）───────
  // 三步镜像：签名拿 assetId 与直传地址 → PUT 字节到 mock OSS → 登记拿回公网地址。
  // 登记响应的 assetType/contentType 照签名时记下的类型给（与后端从桶里读到的口径一致）。
  http.post('*/api/uploads/sign', async ({ request }) => {
    const body = (await request.json()) as { contentType: string }
    const assetId = crypto.randomUUID()
    mockUploads.set(assetId, body.contentType)
    return HttpResponse.json({
      assetId,
      upload: {
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        headers: { 'Content-Type': body.contentType },
        url: `http://localhost/mock-oss/${assetId}`,
      },
    })
  }),

  http.put('*/mock-oss/:assetId', () => new HttpResponse(null, { status: 200 })),

  http.post('*/api/assets/:assetId', ({ params }) => {
    const assetId = params['assetId'] as string
    const contentType = mockUploads.get(assetId) ?? 'image/png'
    return HttpResponse.json(
      {
        asset: {
          assetType: contentType.startsWith('video/') ? 'video' : 'image',
          contentType,
          createdAt: new Date().toISOString(),
          creatorUserId: mockAuthUser.id,
          id: assetId,
          sizeBytes: 1024,
          url: `http://localhost/mock-oss/${assetId}`,
        },
      },
      { status: 201 },
    )
  }),

  // ── transcript（src/shared/transcript）─────────────────────────────────
  ...transcriptHandlers,
]
