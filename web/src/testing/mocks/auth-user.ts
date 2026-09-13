// 单测与 dev:mock 共用的登录身份；单独成模块，transcript 与 handlers 两边的 mock 都能引用它而不成环。
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
    'agent:read',
    'agent:run',
    'generation:read',
    'generation:submit',
    'inspirations:read',
    'uploads:write',
    'collections:read',
    'collections:write',
    'tasks:read',
    'tasks:write',
  ],
  roles: ['editor'],
  username: 'tester',
}

/** 治理者账号：用 governor 登录 mock 就是它，多一个 users:manage，看得到全部对话与别人的会话页。 */
export const mockGovernor = {
  ...mockAuthUser,
  displayName: '治理者',
  email: 'governor@example.com',
  id: '4b9d2e7a-1c3f-4a5b-8d6e-2f7a9c1b3d5e',
  permissions: [...mockAuthUser.permissions, 'users:manage'],
  roles: ['root'],
  username: 'governor',
}
