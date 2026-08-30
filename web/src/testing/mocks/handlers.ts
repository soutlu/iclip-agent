import { http, HttpResponse } from 'msw'

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
  permissions: ['collections:read', 'collections:write', 'tasks:read', 'tasks:write'],
  roles: ['editor'],
  username: 'tester',
}

// 登录态是有状态的：没登录过 /users/me 就是 401，登录后才有用户——否则登录页永远直接被
// 守卫送回首页，登录旅程根本走不到。浏览器里这份状态随页面刷新归零，单测在 afterEach 归零。
let sessionActive = false

export const resetMockSession = () => {
  sessionActive = false
}

// 对话的内存存储：形状即合同 ConversationOut。搜索按标题过滤，跟后端一样不分大小写。
type MockConversation = {
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
]
