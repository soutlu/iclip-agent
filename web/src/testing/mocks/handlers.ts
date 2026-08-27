import { http, HttpResponse } from 'msw'

// ─────────────────────────────────────────────────────────────────────────────
// MSW REST 契约镜像
//
//   - 单测：src/testing/setup.ts 已全局 listen / reset / close，测试里只在需要改响应时
//     `server.use(...)` 覆盖单个端点。
//   - 浏览器原型：仅 `pnpm dev:mock` 经 browser.ts 注册本数组；普通 `pnpm dev` 不注册。
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
