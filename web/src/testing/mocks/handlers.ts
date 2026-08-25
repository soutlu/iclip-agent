import { http, HttpResponse } from 'msw'

// ─────────────────────────────────────────────────────────────────────────────
// MSW canonical REST 契约镜像
//
// 用法：
//   - 单测（node 端）：`import { server } from '@/testing/mocks/server'`，在测试文件里
//     `beforeAll(() => server.listen())` / `afterEach(() => server.resetHandlers())` /
//     `afterAll(() => server.close())`。全局 setup 仍不接线，避免干扰存量 fetch 行为 mock。
//   - 浏览器原型：仅 `pnpm dev:mock` 经 browser.ts 注册本数组；普通 `pnpm dev` 不注册
//     canonical handlers，未命中的请求仍走真实后端。
//   - 单个测试覆盖响应：`server.use(http.get('*/api/users/me', () => HttpResponse.json(...)))`。
//
// 扩展方式：
//   - handlers 镜像 iclip_agent 后端 REST 契约。后端路由挂根路径，前端一律经 `/api`
//     前缀走同源代理（vite proxy / nginx 会去掉 `/api`），因此 handler 匹配前端视角的
//     `*/api/...` 路径（`*` 前缀兼容 node 端绝对 URL 与浏览器端相对 URL）。
//   - 响应形状以前端 API 层的解析函数为准（parse/map 函数即前端侧契约事实源）：
//     auth 见 src/shared/auth/producer-auth.api.ts，项目见
//     src/features/projects/api/producer-project.api.ts。新增接口时先读对应 API 层。
//   - WS（/api/generations/ws 生成事件）与 AG-UI 流式端点 MSW 支持有限，**不用 MSW**，
//     沿用现有测试的注入 stub 方案（参考 project-chat-provider.test.tsx 的 fetch/WS stub）。
//   - 真实后端尚不存在的页面数据留在对应 feature 内嵌，不注册虚构的原型接口。
// ─────────────────────────────────────────────────────────────────────────────

/** 默认已登录用户：持有 editor 全量权限，形状对齐 parseProducerAuthUser。 */
export const mockAuthUser = {
  avatarUrl: '',
  displayName: '测试用户',
  id: 'user-1',
  permissions: ['projects:read', 'projects:write'],
  roles: ['editor'],
  username: 'tester',
}

/** 默认项目列表：形状对齐 mapProducerProject（kind 仅 'agent' | 'direct'）。 */
export const mockProjects = [
  {
    createdAt: '2026-07-01T00:00:00Z',
    id: 'project-1',
    kind: 'agent',
    sessionIds: ['session-1'],
    title: '测试项目',
    updatedAt: '2026-07-02T00:00:00Z',
  },
]

/** dev:mock 内存任务账本（node 测试一律用 server.use 覆盖，不依赖此状态）。 */
const mockVideoTasks: Array<Record<string, unknown> & { id: string; status: string }> = []

/** dev:mock 内存素材账本：登记（直传或转存）之后可被 GET /assets 列出。 */
const mockAssets: Array<{
  assetType: string
  contentType: string
  createdAt: string
  creatorUserId: string
  id: string
  sizeBytes: number
  url: string
}> = []

/** 签名时说过的类型：登记那一步没有请求体，mock 只能靠它还原（真后端是回桶里读）。 */
const mockSignedContentTypes = new Map<string, string>()

/** 爆款库推荐视频固定样本（排序字段齐全，sortBy 在 handler 内生效）。 */
export const mockInspirationVideos = [
  {
    creatorHandle: '@sneaker.daily',
    metrics: {
      clicks: 4200,
      impressions: 1200000,
      orders: 320,
      revenue: '12999.50',
      views: 90000,
    },
    ossUrl: 'https://oss.example.com/inspiration/video-orders.mp4',
    postedDate: '2026-07-08',
    styleWms: 'SNST26006U-WMS',
    videoId: 'video-orders',
    videoUrl: 'https://video.example.com/video-orders.mp4',
  },
  {
    creatorHandle: '@outdoor.walks',
    metrics: {
      clicks: 9000,
      impressions: 2600000,
      orders: 120,
      revenue: '5200.00',
      views: 480000,
    },
    ossUrl: 'https://oss.example.com/inspiration/video-views.mp4',
    postedDate: '2026-06-21',
    styleWms: 'SNST26006U-WMS',
    videoId: 'video-views',
    videoUrl: 'https://video.example.com/video-views.mp4',
  },
  {
    creatorHandle: null,
    metrics: {
      clicks: 1500,
      impressions: 600000,
      orders: 45,
      revenue: '1800.00',
      views: 30000,
    },
    ossUrl: null,
    postedDate: null,
    styleWms: 'RAIN2026-WMS',
    videoId: 'video-substitute',
    videoUrl: 'https://video.example.com/video-substitute.mp4',
  },
]

const mockWebInspirationPosts = {
  instagram: [
    {
      creatorHandle: '@mock.instagram',
      durationSeconds: null,
      platformVideoId: 'mock-instagram-001',
      postUrl: 'https://social.example.com/reel/mock-instagram-001/',
      selectionToken: 'selection-token-instagram-001',
      thumbnailUrl: null,
      title: 'Mock Instagram water shoes',
    },
  ],
  tiktok: [
    {
      creatorHandle: '@mock.creator',
      durationSeconds: 18,
      platformVideoId: 'mock-tiktok-001',
      postUrl: 'https://www.tiktok.com/@mock.creator/video/mock-tiktok-001',
      selectionToken: 'selection-token-tiktok-001',
      thumbnailUrl: null,
      title: 'Mock TikTok water shoes',
    },
  ],
  youtube: [
    {
      creatorHandle: '@mock-channel',
      durationSeconds: 24,
      platformVideoId: 'mock-youtube-001',
      postUrl: 'https://www.youtube.com/watch?v=mock-youtube-001',
      selectionToken: 'selection-token-youtube-001',
      thumbnailUrl: 'https://i.ytimg.com/vi/mock-youtube-001/hqdefault.jpg',
      title: 'Mock YouTube water shoes',
    },
  ],
} as const

const mockWebInspirationDurations = {
  instagram: 20,
  tiktok: 18,
  youtube: 24,
} as const

const MOCK_EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
}

/**
 * 登记一条内存素材（直传与转存共用）。
 *
 * @param input - 素材 id 与 content type。
 * @returns 已入账本的那一行；同一个 id 重复登记返回同一行。
 */
const registerMockAsset = ({ assetId, contentType }: { assetId: string; contentType: string }) => {
  const existing = mockAssets.find((asset) => asset.id === assetId)
  if (existing) {
    return existing
  }

  const extension = MOCK_EXTENSION_BY_CONTENT_TYPE[contentType] ?? 'bin'
  const asset = {
    assetType: contentType.startsWith('video/') ? 'video' : 'image',
    contentType,
    createdAt: new Date().toISOString(),
    creatorUserId: mockAuthUser.id,
    id: assetId,
    sizeBytes: 1024,
    // 地址带上真实扩展名：前端按它判断媒体类型（见 video-task.api.ts）。
    url: `https://oss.mock.example.com/public/${assetId}.${extension}`,
  }
  mockAssets.push(asset)
  return asset
}

/**
 * 推进内存任务的状态并返回标准响应。
 *
 * @param taskId - 目标任务 id。
 * @param status - 目标状态。
 * @returns 任务包装响应；任务不存在时 404。
 */
const transitionMockVideoTask = (taskId: string, status: 'confirmed' | 'published') => {
  const task = mockVideoTasks.find((item) => item.id === taskId)
  if (!task) {
    return HttpResponse.json({ detail: 'Video Task 不存在' }, { status: 404 })
  }
  task.status = status
  task.updatedAt = new Date().toISOString()
  return HttpResponse.json({ task })
}

export const handlers = [
  // ── auth（src/shared/auth/producer-auth.api.ts）─────────────────────────────
  // GET /users/me：会话唯一事实源，响应为 { user } 包装；未登录时后端返回 401。
  http.get('*/api/users/me', () => HttpResponse.json({ user: mockAuthUser })),

  // POST /auth/login：fastapi-users OAuth2 表单登录，成功 204 并种 HttpOnly cookie。
  http.post('*/api/auth/login', () => new HttpResponse(null, { status: 204 })),

  // POST /auth/logout：注销会话并清 cookie；会话本就失效时后端返回 401（前端视为成功）。
  http.post('*/api/auth/logout', () => new HttpResponse(null, { status: 204 })),

  // ── 项目列表（src/features/projects/api/producer-project.api.ts）───────────
  // GET /projects：当前登录用户可访问的项目文件夹列表，响应为 { projects } 包装。
  http.get('*/api/projects', () => HttpResponse.json({ projects: mockProjects })),

  // ── 创作需求单（src/features/tasks/api/video-task.api.ts）──────────────────
  // 浏览器原型的内存任务账本：下发（create+publish）与确认在 dev:mock 下可走通全流程。
  http.get('*/api/tasks', () => HttpResponse.json({ items: mockVideoTasks })),
  http.post('*/api/tasks', async ({ request }) => {
    const body = (await request.json()) as {
      brief?: Record<string, unknown>
      deadline?: null | string
      styleNo?: string
      title?: string
    }
    const now = new Date().toISOString()
    const task = {
      brief: { referenceImages: [], referenceVideos: [], ...body.brief },
      createdAt: now,
      creatorUserId: mockAuthUser.id,
      deadline: body.deadline ?? null,
      id: `mock-task-${String(mockVideoTasks.length + 1)}`,
      priority: 0,
      status: 'draft',
      style: {
        brand: 'NORTIV8',
        category: '运动凉鞋',
        previewImageUrl: 'https://assets.example.com/SNST26006U-1.jpg',
        styleNo: body.styleNo ?? '',
      },
      title: body.title ?? body.styleNo ?? '',
      updatedAt: now,
    }
    mockVideoTasks.push(task)
    return HttpResponse.json({ task }, { status: 201 })
  }),
  // PUT /tasks/{taskId} 是整体覆盖；mock 不复刻「下发即冻结」那套比对，直接盖。
  http.put('*/api/tasks/:taskId', async ({ params, request }) => {
    const task = mockVideoTasks.find((item) => item.id === String(params.taskId))
    if (!task) {
      return HttpResponse.json({ detail: '需求单不存在' }, { status: 404 })
    }
    const body = (await request.json()) as { brief?: Record<string, unknown> }
    task.brief = { ...(task.brief as Record<string, unknown>), ...body.brief }
    task.updatedAt = new Date().toISOString()
    return HttpResponse.json({ task })
  }),
  http.post('*/api/tasks/:taskId/publish', ({ params }) =>
    transitionMockVideoTask(String(params.taskId), 'published'),
  ),
  http.post('*/api/tasks/:taskId/confirm', ({ params }) =>
    transitionMockVideoTask(String(params.taskId), 'confirmed'),
  ),

  // ── 产品资料（src/features/tasks/api/video-task.api.ts）────────────────────
  // GET /products/{styleNo}：码永远有、名字可能是 null；图不带颜色归属。
  http.get('*/api/products/:styleNo', ({ params }) => {
    const styleNo = String(params.styleNo)
    if (styleNo !== 'SNST26006U') {
      return HttpResponse.json({ detail: `未找到款号 ${styleNo}` }, { status: 404 })
    }

    return HttpResponse.json({
      product: {
        brand: { code: '2', name: 'NORTIV8' },
        category: { code: 'SD', id: 61, name: '运动凉鞋' },
        colors: [
          { code: 'BK07', name: 'ALL BLACK' },
          { code: 'BL03', name: 'BLUE/BLACK' },
          { code: 'GY01', name: null },
        ],
        images: Array.from({ length: 6 }, (_, index) => ({
          height: 508,
          id: `SNST26006U-${String(index + 1)}`,
          url: `https://assets.example.com/products/mock-product/image-${String(index + 1)}.jpg`,
          width: 644,
        })),
        styleNo,
        styleWms: 'SNST26006U-WMS',
      },
    })
  }),

  // ── 素材账本（src/shared/lib/file-upload.ts）───────────────────────────────
  // 签名 → 直传 PUT → 登记；外部地址走转存。内容在 dev:mock 下不真正存储。
  http.post('*/api/uploads/sign', async ({ request }) => {
    const body = (await request.json()) as { contentType?: string }
    const contentType = body.contentType ?? 'image/jpeg'
    const assetId = `mock-asset-${String(mockSignedContentTypes.size + 1)}`
    // 登记那一步没有请求体，类型只能由「签名时说过什么」记着——真后端是回桶里读。
    mockSignedContentTypes.set(assetId, contentType)
    return HttpResponse.json({
      assetId,
      upload: {
        expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
        headers: { 'Content-Type': contentType },
        method: 'PUT',
        url: `https://oss.mock.example.com/upload/${assetId}`,
      },
    })
  }),
  http.put('https://oss.mock.example.com/upload/*', () => new HttpResponse(null, { status: 200 })),
  http.post('*/api/assets/import', async ({ request }) => {
    const source = ((await request.json()) as { url?: string }).url ?? ''
    return HttpResponse.json(
      {
        // 真后端按源地址算 uuid5；mock 拿地址本身当键，同样是「一个地址只有一行」。
        asset: registerMockAsset({
          assetId: `mock-import-${encodeURIComponent(source)}`,
          contentType: source.endsWith('.mp4') ? 'video/mp4' : 'image/jpeg',
        }),
      },
      { status: 201 },
    )
  }),
  http.post('*/api/assets/:assetId', ({ params }) => {
    const assetId = String(params.assetId)
    const contentType = mockSignedContentTypes.get(assetId)
    if (contentType === undefined) {
      return HttpResponse.json({ detail: '这份素材还没传上来，传完再登记' }, { status: 409 })
    }
    return HttpResponse.json(
      { asset: registerMockAsset({ assetId, contentType }) },
      { status: 201 },
    )
  }),
  http.get('*/api/assets', () => HttpResponse.json({ items: mockAssets })),

  // ── 创作灵感目录（src/features/tasks/api/inspiration.api.ts）────────────────
  // POST /inspirations/videos/search：收 WMS 编号（不是 PDM 款号），按 sortBy 服务端排序。
  http.post('*/api/inspirations/videos/search', async ({ request }) => {
    const sortBy = ((await request.json()) as { sortBy?: string }).sortBy ?? 'orders'
    const items = [...mockInspirationVideos].sort((left, right) =>
      sortBy === 'clicks' || sortBy === 'impressions' || sortBy === 'orders' || sortBy === 'views'
        ? right.metrics[sortBy] - left.metrics[sortBy]
        : Number(right.metrics.revenue) - Number(left.metrics.revenue),
    )
    return HttpResponse.json({ items })
  }),
  // POST /inspirations/videos/web-search：每次只搜索一个平台，只返回可预览候选。
  http.post('*/api/inspirations/videos/web-search', async ({ request }) => {
    const body = (await request.json()) as {
      category?: string
      platform?: 'instagram' | 'tiktok' | 'youtube'
      scene?: string
      sellingPoint?: string
    }
    if (!body.platform) {
      return HttpResponse.json({ detail: 'platform 必填' }, { status: 422 })
    }
    return HttpResponse.json({
      items: mockWebInspirationPosts[body.platform].map((post, index) => ({
        ...post,
        responsePosition: index + 1,
      })),
      platform: body.platform,
      query: [body.category, body.scene, body.sellingPoint].filter(Boolean).join(' '),
      source: 'web',
    })
  }),
  // POST /inspirations/videos/web-enrich：只按 opaque token 补齐元数据，不下载视频。
  http.post('*/api/inspirations/videos/web-enrich', async ({ request }) => {
    const body = (await request.json()) as {
      platform?: 'instagram' | 'tiktok' | 'youtube'
      selectionTokens?: string[]
    }
    if (!body.platform) {
      return HttpResponse.json({ detail: 'platform 必填' }, { status: 422 })
    }
    const platform = body.platform
    const posts = mockWebInspirationPosts[platform]
    return HttpResponse.json({
      items: (body.selectionTokens ?? []).flatMap((selectionToken) => {
        const index = posts.findIndex((post) => post.selectionToken === selectionToken)
        const post = posts[index]
        return post
          ? [
              {
                durationSeconds: mockWebInspirationDurations[platform],
                metrics: {
                  commentCount: 380,
                  likeCount: 26_000,
                  shareCount: platform === 'youtube' ? null : 940,
                  viewCount: 540_000,
                },
                platformVideoId: post.platformVideoId,
                responsePosition: index + 1,
                selectionToken,
                thumbnailUrl:
                  post.thumbnailUrl ??
                  `https://images.mock.example.com/${platform}/${post.platformVideoId}.jpg`,
              },
            ]
          : []
      }),
      platform,
      source: 'web',
    })
  }),
]
