import { useCallback } from 'react'
import { useLogout, useUser } from '@/shared/auth'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { PopupContent, usePopupAnchor } from '@/shared/ui/popup'

type ProducerUserMenuAlign = 'bottom-end' | 'bottom-start' | 'top-end' | 'top-start'

type ProducerUserMenuProps = {
  align?: ProducerUserMenuAlign
  className?: string
}

const USER_AVATAR_BUTTON_CLASS =
  'inline-flex h-8 w-8 min-w-8 items-center justify-center overflow-hidden rounded-full text-body-sm font-semibold select-none transition-all ui-motion-s focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-chat-focus-ring active:scale-95'

/**
 * 渲染当前用户头像、用户名菜单和退出登录操作。
 *
 * @param props - 用户菜单属性。
 * @param props.align - 弹出菜单相对头像的定位方向。
 * @param props.className - 头像按钮额外样式类。
 * @returns 用户菜单组件。
 */
export function ProducerUserMenu({ align = 'bottom-end', className = '' }: ProducerUserMenuProps) {
  const { data: user } = useUser()
  const logoutMutation = useLogout()
  const {
    anchorRect,
    open: menuOpen,
    setOpen: setMenuOpen,
    triggerRef,
    updateAnchorRect,
  } = usePopupAnchor<HTMLButtonElement>()
  const isLoggingOut = logoutMutation.isPending

  const closeMenu = useCallback(() => {
    setMenuOpen(false)
  }, [setMenuOpen])

  const handleLogout = useCallback(() => {
    if (logoutMutation.isPending) {
      return
    }

    // 退出后不跳转：会话事实源翻成 null，当前页就地退回未登录形态
    logoutMutation.mutate()
  }, [logoutMutation])

  // SSO 自动建号的用户没有 username，优先展示 SSO 同步来的 displayName。
  const userLabel = user?.displayName || user?.username || '用户'
  const departments = user?.departments ?? []
  const hasProfileDetails = Boolean(user?.jobTitle || user?.city || departments.length)
  // 头像三级策略：SSO 头像图 > 用户名首字母（品牌青底） > 通用轮廓（未拿到用户时）。
  const avatarUrl = user?.avatarUrl.trim() ?? ''
  const avatarInitial = user ? userLabel.trim().charAt(0).toUpperCase() : ''

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={menuOpen}
        aria-haspopup="menu"
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
        data-producer-user-avatar="true"
        onClick={() => {
          updateAnchorRect()
          setMenuOpen((current) => !current)
        }}
      >
        {avatarUrl ? (
          <img src={avatarUrl} alt="" className="h-full w-full object-cover" />
        ) : avatarInitial ? (
          <span aria-hidden="true">{avatarInitial}</span>
        ) : (
          <ProducerUserAvatarIcon />
        )}
      </button>

      <PopupContent
        open={menuOpen}
        anchorRect={anchorRect}
        align={align}
        onDismiss={closeMenu}
        role="menu"
        aria-label="用户菜单"
        className="w-[280px] overflow-hidden py-1.5"
      >
        <div className="border-b border-border px-4 py-3">
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
        <button
          type="button"
          role="menuitem"
          disabled={isLoggingOut}
          className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left text-body-sm text-on-background transition-colors duration-[var(--dur-s)] hover:bg-hover focus-visible:bg-hover disabled:cursor-wait disabled:text-disabled-text"
          onClick={handleLogout}
        >
          <span>{isLoggingOut ? '退出中' : '退出登录'}</span>
          <Icon decorative name="logout" size="md" />
        </button>
      </PopupContent>
    </>
  )
}

/**
 * 渲染用户头像图形。
 *
 * @returns 极简用户轮廓 SVG。
 */
function ProducerUserAvatarIcon() {
  return (
    <svg
      aria-hidden="true"
      className="shrink-0"
      data-producer-user-avatar-icon="true"
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
