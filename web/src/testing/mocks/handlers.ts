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

/** dev:mock 内存素材账本：登记（upload/import）后可被 GET /assets 解析。 */
const mockAssets: Array<{ assetType: string; id: string; mimeType: null | string; url: string }> =
  []

/** 爆款库推荐视频固定样本（排序字段齐全，sortBy 在 handler 内生效）。 */
export const mockInspirationVideos = [
  {
    creatorHandle: '@sneaker.daily',
    metrics: {
      clicks: 4200,
      impressions: 1200000,
      orders: 320,
      revenueAmount: '12999.50',
      views: 90000,
    },
    ossUrl: 'https://oss.example.com/inspiration/video-orders.mp4',
    postedDate: '2026-07-08',
    styleNo: 'SNST26006U',
    videoId: 'video-orders',
    videoUrl: 'https://video.example.com/video-orders.mp4',
  },
  {
    creatorHandle: '@outdoor.walks',
    metrics: {
      clicks: 9000,
      impressions: 2600000,
      orders: 120,
      revenueAmount: '5200.00',
      views: 480000,
    },
    ossUrl: 'https://oss.example.com/inspiration/video-views.mp4',
    postedDate: '2026-06-21',
    styleNo: 'SNST26006U',
    videoId: 'video-views',
    videoUrl: null,
  },
  {
    creatorHandle: null,
    metrics: {
      clicks: 1500,
      impressions: 600000,
      orders: 45,
      revenueAmount: '1800.00',
      views: 30000,
    },
    ossUrl: 'https://oss.example.com/inspiration/video-substitute.mp4',
    postedDate: null,
    styleNo: 'RAIN2026',
    videoId: 'video-substitute',
    videoUrl: null,
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

/**
 * 登记一条内存素材（upload / import 共用），并分配稳定递增 id。
 *
 * @param input - 素材类型、MIME 与最终 URL。
 * @returns 已入账本的素材记录。
 */
const registerMockAsset = ({
  assetType,
  mimeType,
  url,
}: {
  assetType: string
  mimeType: null | string
  url: string
}) => {
  const asset = {
    assetType,
    id: `mock-asset-${String(mockAssets.length + 1)}`,
    mimeType,
    url,
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

  // ── Video Task（src/features/tasks/api/video-task.api.ts）──────────────────
  // 浏览器原型的内存任务账本：下发（create+publish）与确认在 dev:mock 下可走通全流程。
  http.get('*/api/video-tasks', () => HttpResponse.json({ tasks: mockVideoTasks })),
  http.post('*/api/video-tasks', async ({ request }) => {
    const body = (await request.json()) as {
      brief?: Record<string, unknown>
      deadline?: null | string
      styleNo?: string
    }
    const task = {
      brief: { referenceImages: [], referenceVideos: [], ...body.brief },
      createdAt: new Date().toISOString(),
      deadline: body.deadline ?? null,
      id: `mock-task-${String(mockVideoTasks.length + 1)}`,
      priority: 0,
      schemaVersion: 1,
      status: 'draft',
      style: {
        brand: 'NORTIV8',
        category: '运动凉鞋',
        previewImageUrl: 'https://assets.example.com/SNST26006U-1.jpg',
        styleNo: body.styleNo ?? '',
      },
      title: body.styleNo ?? '',
      updatedAt: new Date().toISOString(),
    }
    mockVideoTasks.push(task)
    return HttpResponse.json({ task }, { status: 201 })
  }),
  // PUT /video-tasks/{taskId}：published/confirmed 下仅参考素材（连同 deadline）可变，
  // mock 不复刻冻结校验，直接整单覆盖。
  http.put('*/api/video-tasks/:taskId', async ({ params, request }) => {
    const task = mockVideoTasks.find((item) => item.id === String(params.taskId))
    if (!task) {
      return HttpResponse.json({ detail: 'Video Task 不存在' }, { status: 404 })
    }
    const body = (await request.json()) as { brief?: Record<string, unknown> }
    task.brief = { ...(task.brief as Record<string, unknown>), ...body.brief }
    task.updatedAt = new Date().toISOString()
    return HttpResponse.json({ task })
  }),
  http.post('*/api/video-tasks/:taskId/publish', ({ params }) =>
    transitionMockVideoTask(String(params.taskId), 'published'),
  ),
  http.post('*/api/video-tasks/:taskId/confirm', ({ params }) =>
    transitionMockVideoTask(String(params.taskId), 'confirmed'),
  ),
  http.get('*/api/video-tasks/product-info', ({ request }) => {
    const styleNo = new URL(request.url).searchParams.get('styleNo')
    if (styleNo !== 'SNST26006U') {
      return HttpResponse.json({ detail: `未找到 Style ${styleNo ?? ''}` }, { status: 404 })
    }

    return HttpResponse.json({
      product: {
        brand: 'NORTIV8',
        category: '运动凉鞋',
        images: Array.from({ length: 6 }, (_, index) => ({
          color: index < 4 ? 'BLUE/BLACK' : 'ALL BLACK',
          id: `SNST26006U-${String(index + 1)}`,
          url: `https://assets.example.com/products/mock-product/image-${String(index + 1)}.jpg`,
        })),
        colors: [
          { id: '7', name: 'ALL BLACK' },
          { id: '3', name: 'BLUE/BLACK' },
          { id: '9', name: 'GREY/ORANGE' },
        ],
        styleNo,
      },
    })
  }),

  // POST /video-tasks/product-images/import：选中产品图一批「按需转存 OSS + 登记 import
  // Asset」。产品图量级很大，禁止批量搬运——product-info 里除首图外都是源地址，仅选中图经此处理。
  http.post('*/api/video-tasks/product-images/import', async ({ request }) => {
    const body = (await request.json()) as { imageIds?: string[] }
    return HttpResponse.json({
      assets: (body.imageIds ?? []).map((imageId) => {
        const asset = registerMockAsset({
          assetType: 'image',
          mimeType: null,
          url: `https://oss.mock.example.com/product-catalog/${encodeURIComponent(imageId)}.jpg`,
        })
        return { assetId: asset.id, imageId, url: asset.url }
      }),
    })
  }),

  // ── 全局素材账本（src/features/tasks/api/video-task.api.ts）─────────────────
  // POST /assets：登记 upload/import 素材；GET /assets?assetId=…：按 id 批量解析。
  http.post('*/api/assets', async ({ request }) => {
    const body = (await request.json()) as {
      assetType?: string
      mimeType?: null | string
      url?: string
    }
    const asset = registerMockAsset({
      assetType: body.assetType ?? 'image',
      mimeType: body.mimeType ?? null,
      url: body.url ?? '',
    })
    return HttpResponse.json({ asset }, { status: 201 })
  }),
  http.get('*/api/assets', ({ request }) => {
    const wanted = new Set(new URL(request.url).searchParams.getAll('assetId'))
    return HttpResponse.json({ assets: mockAssets.filter((asset) => wanted.has(asset.id)) })
  }),

  // POST /presign + OSS 直传 PUT：dev:mock 下让上传链路可走通（内容不真正存储）。
  http.post('*/api/presign', async ({ request }) => {
    const body = (await request.json()) as { ext?: string }
    const key = `mock-upload-${String(Date.now())}.${body.ext ?? 'bin'}`
    return HttpResponse.json({
      content_type: 'application/octet-stream',
      public_url: `https://oss.mock.example.com/public/${key}`,
      upload_url: `https://oss.mock.example.com/upload/${key}`,
    })
  }),
  http.put('https://oss.mock.example.com/upload/*', () => new HttpResponse(null, { status: 200 })),

  // ── 创作灵感目录（src/features/tasks/api/inspiration.api.ts）────────────────
  // POST /inspirations/videos/search：按 styleNos 命中样本并按 sortBy 服务端排序。
  http.post('*/api/inspirations/videos/search', async ({ request }) => {
    const body = (await request.json()) as { sortBy?: string; styleNos?: string[] }
    const styleNos = body.styleNos ?? []
    const exact = new Set(
      mockInspirationVideos
        .filter((video) => styleNos.includes(video.styleNo))
        .map((video) => video.styleNo),
    )
    const sortBy = body.sortBy ?? 'orders'
    const items = [...mockInspirationVideos].sort((left, right) =>
      sortBy === 'clicks' || sortBy === 'impressions' || sortBy === 'orders' || sortBy === 'views'
        ? right.metrics[sortBy] - left.metrics[sortBy]
        : Number(right.metrics.revenueAmount) - Number(left.metrics.revenueAmount),
    )
    return HttpResponse.json({
      count: items.length,
      items,
      matches: styleNos.map((styleNo) => ({
        matchLevel: exact.has(styleNo) ? 'exact' : 'sameCategory',
        styleNo,
      })),
    })
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
  // POST /inspirations/videos/web-import：只下载本次保存明确选中的 opaque token。
  http.post('*/api/inspirations/videos/web-import', async ({ request }) => {
    const body = (await request.json()) as { selectionTokens?: string[]; taskId?: string }
    const candidates = Object.entries(mockWebInspirationPosts).flatMap(([platform, posts]) =>
      posts.map((post) => ({ ...post, platform })),
    )
    return HttpResponse.json(
      {
        assets: (body.selectionTokens ?? []).flatMap((selectionToken) => {
          const candidate = candidates.find((item) => item.selectionToken === selectionToken)
          if (!candidate) {
            return []
          }
          const url = `https://oss.mock.example.com/web-inspirations/${candidate.platform}/${candidate.platformVideoId}.mp4`
          const asset =
            mockAssets.find((item) => item.url === url) ??
            registerMockAsset({ assetType: 'video', mimeType: 'video/mp4', url })
          return [
            {
              assetId: asset.id,
              durationSeconds: candidate.durationSeconds,
              platform: candidate.platform,
              platformVideoId: candidate.platformVideoId,
              selectionToken,
              url,
            },
          ]
        }),
      },
      { status: 201 },
    )
  }),
  // POST /inspirations/videos/import：只转存用户点名的视频；相同源 URL 由后端稳定 key 复用。
  http.post('*/api/inspirations/videos/import', async ({ request }) => {
    const body = (await request.json()) as { videoIds?: string[] }
    return HttpResponse.json(
      {
        assets: (body.videoIds ?? []).map((videoId) => {
          const asset = registerMockAsset({
            assetType: 'video',
            mimeType: 'video/mp4',
            url: `https://oss.mock.example.com/inspiration-videos/by-source/${encodeURIComponent(videoId)}`,
          })
          return { assetId: asset.id, url: asset.url, videoId }
        }),
      },
      { status: 201 },
    )
  }),
]
