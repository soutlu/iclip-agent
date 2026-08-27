import { http, HttpResponse } from 'msw'

// ─────────────────────────────────────────────────────────────────────────────
// MSW canonical REST 契约镜像
//
// 用法：
//   - 单测（node 端）：`import { server } from '@/testing/mocks/server'`，在测试文件里
//     `beforeAll(() => server.listen())` / `afterEach(() => server.resetHandlers())` /
//     `afterAll(() => server.close())`。
//   - 浏览器原型：仅 `pnpm dev:mock` 经 browser.ts 注册本数组；普通 `pnpm dev` 不注册。
//
// 页面层重写期间这里只剩登录链路——加回一个页面就补它消费的那几个端点，
// 端点形状以 docs/backend_api.md 为准，不在这里凭印象编。
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

export const handlers = [
  // ── auth（src/shared/auth/producer-auth.api.ts）─────────────────────────────
  // GET /users/me：会话唯一事实源，响应为 { user } 包装；未登录时后端返回 401。
  http.get('*/api/users/me', () => HttpResponse.json({ user: mockAuthUser })),

  // POST /auth/login：fastapi-users OAuth2 表单登录，成功 204 并种 HttpOnly cookie。
  http.post('*/api/auth/login', () => new HttpResponse(null, { status: 204 })),

  // POST /auth/logout：注销会话并清 cookie；会话本就失效时后端返回 401（前端视为成功）。
  http.post('*/api/auth/logout', () => new HttpResponse(null, { status: 204 })),
]
