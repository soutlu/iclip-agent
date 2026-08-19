import { Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import {
  ADMIN_USER_ROLE_OPTIONS,
  type AdminUser,
  type AdminUserPatch,
  type AdminUsersPage,
  fetchAdminUsersPage,
  updateAdminUser,
} from '@/features/admin-users/api/admin-users.api'
import { ProducerUserMenu } from '@/features/auth'
import { useUser } from '@/shared/auth'
import { formatDateTime } from '@/shared/lib/datetime'
import HippoIcon from '@/shared/ui/icons/HippoIcon'

const USERS_PAGE_SIZE = 20

type AdminUsersLoadState = 'idle' | 'loading' | 'ready' | 'error'

type AdminUserRowProps = {
  disabled: boolean
  isSelf: boolean
  user: AdminUser
  onPatch: (user: AdminUser, patch: AdminUserPatch) => void
}

/**
 * 渲染用户管理页（管理员为用户配置角色/启停用）。
 *
 * 数据直连后端 `GET /users` 与 `PATCH /users/{id}`（`users:manage` 权限门控）；
 * 当前登录管理员自己的行禁用调整控件，对齐后端「不能自降权/自停用」规则。
 *
 * @returns 用户管理页面。
 */
export default function AdminUsersRoute() {
  const { data: currentUser } = useUser()
  const [page, setPage] = useState(1)
  const [usersPage, setUsersPage] = useState<AdminUsersPage | null>(null)
  const [loadState, setLoadState] = useState<AdminUsersLoadState>('idle')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [pendingUserId, setPendingUserId] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()

    setLoadState('loading')
    setLoadError(null)

    fetchAdminUsersPage({ page, pageSize: USERS_PAGE_SIZE }, controller.signal)
      .then((nextPage) => {
        setUsersPage(nextPage)
        setLoadState('ready')
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return
        }

        setLoadError(error instanceof Error ? error.message : '加载用户列表失败')
        setLoadState('error')
      })

    return () => {
      controller.abort()
    }
  }, [page])

  /**
   * 提交单个用户的调整并将后端返回的最新用户回写到当前页。
   *
   * @param user - 目标用户。
   * @param patch - 要调整的字段。
   */
  const applyUserPatch = async (user: AdminUser, patch: AdminUserPatch) => {
    setPendingUserId(user.id)
    setActionError(null)

    try {
      const updated = await updateAdminUser(user.id, patch)

      setUsersPage((current) =>
        current
          ? {
              ...current,
              items: current.items.map((item) => (item.id === updated.id ? updated : item)),
            }
          : current,
      )
    } catch (error) {
      setActionError(error instanceof Error ? error.message : '更新用户失败')
    } finally {
      setPendingUserId(null)
    }
  }

  const total = usersPage?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / USERS_PAGE_SIZE))

  return (
    <div className="home-workspace analytics-workspace relative flex h-dvh max-h-dvh flex-col overflow-hidden">
      <header className="layer-header pointer-events-none absolute inset-x-0 top-0 flex h-[var(--layout-project-header-height)] items-center justify-between px-4 sm:px-8">
        <Link
          to="/"
          aria-label="返回 Producer 首页"
          className="pointer-events-auto inline-flex h-9 items-center gap-2 rounded-full border border-[var(--home-border)] bg-[var(--home-surface)] px-3 text-body-sm font-semibold text-[var(--home-text)] no-underline backdrop-blur-xl transition hover:bg-[var(--home-surface-strong)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-chat-focus-ring)]"
        >
          <HippoIcon name="back" size={15} />
          <span>首页</span>
        </Link>
        <Link to="/" className="analytics-brand-title home-title pointer-events-auto no-underline">
          Producer Studio is here
        </Link>
        <div className="pointer-events-auto flex items-center gap-1">
          <ProducerUserMenu className="ml-1" />
        </div>
      </header>

      <main className="hide-scrollbar relative isolate flex min-h-0 flex-1 flex-col overflow-hidden">
        <section className="hide-scrollbar layer-content relative flex min-h-0 max-w-full flex-1 flex-col items-center overflow-y-auto px-4 pt-24 pb-12 sm:px-8 sm:pt-28 sm:pb-16">
          <div className="analytics-shell w-full max-w-[min(1280px,calc(100vw-64px))]">
            <div className="analytics-page-heading">
              <div>
                <p className="analytics-eyebrow">User Management</p>
                <h1>用户管理</h1>
              </div>
              <div className="analytics-updated">
                <span className="analytics-updated-icon" aria-hidden="true" />
                <div>
                  <span>用户总数</span>
                  <strong>
                    {loadState === 'error' ? '加载失败' : usersPage ? `${total} 人` : '加载中'}
                  </strong>
                </div>
              </div>
            </div>

            {loadState === 'loading' && !usersPage ? (
              <AdminUsersStatePanel
                title="正在加载用户列表"
                description="读取后端用户管理接口，请稍候。"
              />
            ) : null}
            {loadState === 'error' ? (
              <AdminUsersStatePanel
                title="用户列表加载失败"
                description={loadError ?? '请稍后重试。'}
              />
            ) : null}
            {actionError ? (
              <div className="analytics-state-panel" role="alert">
                <strong>调整失败</strong>
                <span>{actionError}</span>
              </div>
            ) : null}

            {usersPage ? (
              <section className="admin-users-panel" aria-label="用户列表">
                <div className="analytics-section-heading">
                  <h2>成员与角色</h2>
                </div>
                {usersPage.items.length === 0 ? (
                  <p className="analytics-empty-text">暂无用户。</p>
                ) : (
                  <div className="analytics-table-scroll">
                    <table className="analytics-table">
                      <thead>
                        <tr>
                          <th>用户</th>
                          <th>角色</th>
                          <th>状态</th>
                          <th>创建时间</th>
                          <th>最近登录</th>
                          <th>操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {usersPage.items.map((user) => (
                          <AdminUserRow
                            key={user.id}
                            disabled={pendingUserId !== null}
                            isSelf={user.id === currentUser?.id}
                            user={user}
                            onPatch={(target, patch) => {
                              void applyUserPatch(target, patch)
                            }}
                          />
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                <div className="admin-users-pagination">
                  <span>
                    第 {usersPage.page} / {totalPages} 页 · 共 {total} 人
                  </span>
                  <div className="admin-users-pagination-buttons">
                    <button
                      type="button"
                      className="analytics-filter-button admin-users-action-button"
                      disabled={page <= 1 || loadState === 'loading'}
                      onClick={() => setPage((current) => Math.max(1, current - 1))}
                    >
                      上一页
                    </button>
                    <button
                      type="button"
                      className="analytics-filter-button admin-users-action-button"
                      disabled={page >= totalPages || loadState === 'loading'}
                      onClick={() => setPage((current) => current + 1)}
                    >
                      下一页
                    </button>
                  </div>
                </div>
              </section>
            ) : null}
          </div>
        </section>
      </main>
    </div>
  )
}

/**
 * 渲染单个用户行：角色下拉、状态徽标与启停用操作。
 *
 * @param props - 用户行属性。
 * @param props.disabled - 是否有调整请求进行中（进行中时全表禁用，避免并发写）。
 * @param props.isSelf - 是否当前登录管理员本人（后端禁止自降权/自停用，直接禁用控件）。
 * @param props.user - 行内用户。
 * @param props.onPatch - 提交调整回调。
 * @returns 用户表格行。
 */
function AdminUserRow({ disabled, isSelf, user, onPatch }: AdminUserRowProps) {
  const userLabel = user.displayName || user.username || user.email
  const knownRole = ADMIN_USER_ROLE_OPTIONS.some((option) => option.id === user.role)
  const controlsDisabled = disabled || isSelf
  const selfHint = isSelf ? '不能调整自己的账号' : undefined

  return (
    <tr>
      <td>
        <span>{userLabel}</span>
        <p className="admin-users-cell-secondary">
          {user.username ? `@${user.username}` : user.email}
        </p>
      </td>
      <td>
        <label title={selfHint}>
          <span className="sr-only">调整 {userLabel} 的角色</span>
          <select
            className="admin-users-role-select"
            disabled={controlsDisabled}
            value={user.role}
            onChange={(event) => {
              const option = ADMIN_USER_ROLE_OPTIONS.find(
                (candidate) => candidate.id === event.target.value,
              )

              if (!option || option.id === user.role) {
                return
              }

              onPatch(user, { role: option.id })
            }}
          >
            {knownRole ? null : <option value={user.role}>{user.role}</option>}
            {ADMIN_USER_ROLE_OPTIONS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </td>
      <td>
        <span className="admin-users-status-badge" data-active={user.isActive ? 'true' : 'false'}>
          {user.isActive ? '启用中' : '已停用'}
        </span>
      </td>
      <td>{formatDateTime(user.createdAt)}</td>
      <td>{user.lastLoginAt ? formatDateTime(user.lastLoginAt) : '从未登录'}</td>
      <td>
        <button
          type="button"
          className="analytics-filter-button admin-users-action-button"
          disabled={controlsDisabled}
          title={selfHint}
          onClick={() => onPatch(user, { isActive: !user.isActive })}
        >
          {user.isActive ? '停用' : '启用'}
        </button>
      </td>
    </tr>
  )
}

/**
 * 渲染用户管理页状态提示。
 *
 * @param props - 状态提示属性。
 * @param props.description - 状态说明。
 * @param props.title - 状态标题。
 * @returns 状态提示面板。
 */
function AdminUsersStatePanel({ description, title }: { description: string; title: string }) {
  return (
    <div className="analytics-state-panel" role="status">
      <strong>{title}</strong>
      <span>{description}</span>
    </div>
  )
}
