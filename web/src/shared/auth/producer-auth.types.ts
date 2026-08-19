export type ProducerLoginRequest = {
  username: string
  password: string
}

export type ProducerDepartment = {
  id: number
  uid: string
  name: string
  parentId: null | number
  parentUid: string
  leaderUserId: null | number
  leaderUserUid: string
  source: string
  type: string
  order: null | number
}

export type ProducerAuthUser = {
  id: string
  // SSO 首登自动建号的用户没有 username，展示时回退到 displayName。
  username: null | string
  displayName: string
  avatarUrl: string
  // 后端 RBAC 是唯一事实源；前端只按 /users/me 下发的 role 与 permissions 做 UI 展示。
  role: string
  permissions: readonly string[]
  city?: string
  jobTitle?: string
  departments?: readonly ProducerDepartment[]
}
