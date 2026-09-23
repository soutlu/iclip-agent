import { useCallback } from 'react'
import { useLogout, useUser } from '@/shared/auth'
import { cn } from '@/shared/lib/utils'
import { MenuItem, MenuRoot, MenuSurface, MenuTrigger } from '@/shared/ui/menu'

type CueUserMenuAlign = 'bottom-end' | 'bottom-start' | 'top-end' | 'top-start'

type CueUserMenuProps = {
  align?: CueUserMenuAlign
  className?: string
}

const ALIGN_PLACEMENT: Record<
  CueUserMenuAlign,
  { align: 'start' | 'end'; side: 'bottom' | 'top' }
> = {
  'bottom-end': { align: 'end', side: 'bottom' },
  'bottom-start': { align: 'start', side: 'bottom' },
  'top-end': { align: 'end', side: 'top' },
  'top-start': { align: 'start', side: 'top' },
}

const USER_AVATAR_BUTTON_CLASS =
  'inline-flex h-8 w-8 min-w-8 items-center justify-center overflow-hidden rounded-full text-body-sm font-semibold ui-focus select-none transition-all ui-motion-s active:scale-95'

export function CueUserMenu({ align = 'bottom-end', className = '' }: CueUserMenuProps) {
  const { data: user } = useUser()
  const logoutMutation = useLogout()
  const isLoggingOut = logoutMutation.isPending

  const handleLogout = useCallback(() => {
    if (logoutMutation.isPending) {
      return
    }

    // 退出后由会话状态驱动页面更新，保留当前路由。
    logoutMutation.mutate()
  }, [logoutMutation])

  // SSO 自动建号的用户没有 username，优先展示 SSO 同步来的 displayName。
  const userLabel = user?.displayName || user?.username || '用户'
  const departments = user?.departments ?? []
  const hasProfileDetails = Boolean(user?.jobTitle || user?.city || departments.length)
  // 头像依次使用 SSO 图片、用户名首字母和通用轮廓。
  const avatarUrl = user?.avatarUrl.trim() ?? ''
  const avatarInitial = user ? userLabel.trim().charAt(0).toUpperCase() : ''

  return (
    <MenuRoot>
      <MenuTrigger asChild>
        <button
          type="button"
          aria-label="用户菜单"
          title={userLabel}
          className={cn(
            USER_AVATAR_BUTTON_CLASS,
            avatarUrl
              ? 'border border-border bg-top-layer'
              : avatarInitial
                ? 'bg-primary text-on-primary hover:brightness-110'
                : 'border border-border bg-header-btn-bg text-on-background hover:border-border-hover hover:bg-hover',
            className,
          )}
          data-cue-user-avatar="true"
        >
          {avatarUrl ? (
            <img src={avatarUrl} alt="" className="h-full w-full object-cover" />
          ) : avatarInitial ? (
            <span aria-hidden="true">{avatarInitial}</span>
          ) : (
            <CueUserAvatarIcon />
          )}
        </button>
      </MenuTrigger>

      <MenuSurface
        align={ALIGN_PLACEMENT[align].align}
        side={ALIGN_PLACEMENT[align].side}
        // 个人信息与退出项之间不留菜单项间距，保持分隔线贴着退出项。
        className="w-[280px] gap-0 overflow-hidden"
      >
        <div className="border-b border-border px-3 py-2.5">
          <p className="truncate text-body-sm font-semibold text-on-background">{userLabel}</p>
          <p className="mt-0.5 text-caption text-on-surface-variant">当前账号</p>
          {hasProfileDetails ? (
            <dl className="mt-3 grid grid-cols-[44px_minmax(0,1fr)] gap-x-2 gap-y-1.5 border-t border-border pt-3 text-caption">
              {user?.jobTitle ? (
                <>
                  <dt className="text-on-surface-variant">职位</dt>
                  <dd className="truncate text-on-background" title={user.jobTitle}>
                    {user.jobTitle}
                  </dd>
                </>
              ) : null}
              {user?.city ? (
                <>
                  <dt className="text-on-surface-variant">城市</dt>
                  <dd className="truncate text-on-background" title={user.city}>
                    {user.city}
                  </dd>
                </>
              ) : null}
              {departments.length ? (
                <>
                  <dt className="text-on-surface-variant">部门</dt>
                  <dd className="min-w-0 space-y-1 text-on-background">
                    {departments.map((department) => (
                      <p
                        key={`${department.id}:${department.uid}`}
                        className="truncate"
                        title={department.name}
                      >
                        {department.name}
                      </p>
                    ))}
                  </dd>
                </>
              ) : null}
            </dl>
          ) : null}
        </div>
        <MenuItem
          icon="logout"
          disabled={isLoggingOut}
          className="data-disabled:cursor-wait"
          onSelect={(event) => {
            // 菜单留着显示「退出中」；退出成功后侧栏换成登录入口，菜单随之卸载。
            event.preventDefault()
            handleLogout()
          }}
        >
          {isLoggingOut ? '退出中' : '退出登录'}
        </MenuItem>
      </MenuSurface>
    </MenuRoot>
  )
}

function CueUserAvatarIcon() {
  return (
    <svg
      aria-hidden="true"
      className="shrink-0"
      data-cue-user-avatar-icon="true"
      fill="none"
      height="18"
      viewBox="0 0 24 24"
      width="18"
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle cx="12" cy="8.25" r="3.25" stroke="currentColor" strokeWidth="1.75" />
      <path
        d="M5.75 19.25c.78-3.08 3.07-5 6.25-5s5.47 1.92 6.25 5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.75"
      />
    </svg>
  )
}
