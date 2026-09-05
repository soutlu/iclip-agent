import { http, HttpResponse } from 'msw'
import { transcriptHandlers } from './transcript'
import { workspaceHandlers } from './workspace'

// MSW handlers 由单测与 dev:mock 共用；普通 dev 不注册。响应字段以 contract/openapi.json 为准。

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

// 会话状态由登录更新；页面刷新和单测清理后重置为未登录。
let sessionActive = false

// 按 assetId 记录签名时的 contentType，登记响应复用此信息。
const mockUploads = new Map<string, string>()

export const resetMockSession = () => {
  sessionActive = false
}

// 内存对话遵循 ConversationOut，标题搜索不区分大小写。
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

export const addMockConversation = (title: string, updatedAt = new Date().toISOString()) => {
  const conversation: MockConversation = {
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

type MockCollection = {
  createdAt: string
  id: string
  name: string
  ownerUserId: string
  updatedAt: string
}

export const mockCollections: MockCollection[] = []

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

const SIDEBAR_PER_COLLECTION = 10
const SIDEBAR_UNGROUPED = 20

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
  // /users/me 是会话事实源，未登录时返回 401。
  http.get('*/api/users/me', () =>
    sessionActive
      ? HttpResponse.json({ user: mockAuthUser })
      : new HttpResponse(null, { status: 401 }),
  ),

  http.post('*/api/auth/login', () => {
    sessionActive = true
    return new HttpResponse(null, { status: 204 })
  }),

  http.post('*/api/auth/logout', () => {
    sessionActive = false
    return new HttpResponse(null, { status: 204 })
  }),

  // mock 不启用 SSO，以 404 表示路由未挂载。
  http.get('*/api/auth/sso/authorize', () => new HttpResponse(null, { status: 404 })),

  // 模拟 ILIKE 的大小写不敏感标题搜索，按最近活动排序。
  http.get('*/api/conversations/search', ({ request }) => {
    const keyword = (new URL(request.url).searchParams.get('q') ?? '').trim().toLowerCase()
    const items = [...mockConversations]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .filter((item) => !keyword || item.title.toLowerCase().includes(keyword))
    return HttpResponse.json({ items })
  }),

  // 分页游标使用 updatedAt|id；前端将其视为不透明值。
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

  http.post('*/api/conversations', async ({ request }) => {
    const body = (await request.json()) as { agentId: string; title?: string | null }
    const conversation = addMockConversation(body.title ?? '新对话')
    conversation.agentId = body.agentId
    return HttpResponse.json({ conversation }, { status: 201 })
  }),

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

  // 签名、直传与登记共用上传类型记录，保持登记响应与签名一致。
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

  ...workspaceHandlers,

  ...transcriptHandlers,
]
