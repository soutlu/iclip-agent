import { useNavigate } from '@tanstack/react-router'
import type { ChangeEvent, FormEvent } from 'react'
import { useState } from 'react'
import { sanitizeProducerAuthNextPath, startSsoLogin, useLogin } from '@/shared/auth'

type LoginFormProps = {
  nextPath: string
  ssoEnabled: boolean
  initialErrorMessage?: string | undefined
}

/**
 * 渲染并驱动 Producer 登录表单。
 *
 * 飞书登录（公司 SSO）是主通道；账号密码是辅助通道，折叠在次级区域里。
 *
 * @param props - 登录表单属性。
 * @param props.nextPath - 登录成功后的安全站内跳转路径。
 * @param props.ssoEnabled - 后端是否开启企业 SSO 登录，决定飞书入口是否展示。
 * @param props.initialErrorMessage - 初始错误文案（如 SSO 回跳失败），提交后清除。
 * @returns 可发起飞书登录、可提交用户名和密码的登录表单。
 */
export default function LoginForm({ nextPath, ssoEnabled, initialErrorMessage }: LoginFormProps) {
  const navigate = useNavigate()
  const loginMutation = useLogin()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [passwordVisible, setPasswordVisible] = useState(false)
  const [ssoSubmitting, setSsoSubmitting] = useState(false)
  const [errorMessage, setErrorMessage] = useState(initialErrorMessage ?? '')
  // 密码区展开状态：未手动操作过就跟随 ssoEnabled（飞书可用时默认收起）。
  const [passwordOpenOverride, setPasswordOpenOverride] = useState<boolean | null>(null)
  const passwordOpen = passwordOpenOverride ?? !ssoEnabled
  const safeNextPath = sanitizeProducerAuthNextPath(nextPath)
  const submitting = loginMutation.isPending || ssoSubmitting
  const passwordInputType = passwordVisible ? 'text' : 'password'
  const passwordToggleLabel = passwordVisible ? '隐藏密码' : '显示密码'

  /**
   * 同步用户名输入框内容。
   *
   * @param event - 用户名输入框变更事件。
   */
  const handleUsernameChange = (event: ChangeEvent<HTMLInputElement>) => {
    setUsername(event.currentTarget.value)
  }

  /**
   * 同步密码输入框内容。
   *
   * @param event - 密码输入框变更事件。
   */
  const handlePasswordChange = (event: ChangeEvent<HTMLInputElement>) => {
    setPassword(event.currentTarget.value)
  }

  /**
   * 切换密码输入框明文和密文展示状态。
   */
  const handlePasswordVisibilityToggle = () => {
    setPasswordVisible((currentVisible) => !currentVisible)
  }

  /**
   * 展开或收起账号密码辅助登录区。
   */
  const handlePasswordSectionToggle = () => {
    setPasswordOpenOverride(!passwordOpen)
  }

  /**
   * 提交 Producer 登录表单。
   *
   * @param event - 表单提交事件。
   */
  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    const trimmedUsername = username.trim()

    if (trimmedUsername.length === 0) {
      setErrorMessage('请输入用户名')
      return
    }

    if (password.trim().length === 0) {
      setErrorMessage('请输入密码')
      return
    }

    setErrorMessage('')

    try {
      await loginMutation.mutateAsync({
        password,
        username: trimmedUsername,
      })
      // 守卫重算已封装进 useLogin，这里只负责跳转。
      void navigate({ replace: true, to: safeNextPath })
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '登录失败，请稍后重试')
    }
  }

  /**
   * 发起飞书登录（公司 SSO 通道，整页跳转，成功后不会回到本函数）。
   */
  const handleFeishuLogin = async () => {
    setSsoSubmitting(true)
    setErrorMessage('')

    try {
      await startSsoLogin(safeNextPath)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '飞书登录暂不可用，请稍后重试')
      setSsoSubmitting(false)
    }
  }

  return (
    <form
      className="w-full"
      aria-label="Producer 登录表单"
      onSubmit={(event) => {
        void handleSubmit(event)
      }}
    >
      <div className="min-h-6">
        {errorMessage ? (
          <p id="login-error" role="alert" className="producer-auth-error text-body leading-6">
            {errorMessage}
          </p>
        ) : null}
      </div>

      {ssoEnabled ? (
        <>
          <button
            type="button"
            disabled={submitting}
            onClick={() => {
              void handleFeishuLogin()
            }}
            className="producer-auth-feishu-button mt-2 h-12 w-full gap-2.5 text-body font-semibold disabled:cursor-not-allowed"
          >
            <PaperPlaneIcon />
            {ssoSubmitting ? '正在跳转飞书…' : '使用飞书登录'}
          </button>

          <div className="mt-6 flex items-center gap-4" aria-hidden="true">
            <span className="producer-auth-divider" />
            <span className="producer-auth-divider-label text-body-sm">其他登录方式</span>
            <span className="producer-auth-divider" />
          </div>

          <button
            type="button"
            aria-expanded={passwordOpen}
            aria-controls="producer-auth-password-panel"
            onClick={handlePasswordSectionToggle}
            className="producer-auth-secondary-toggle mt-5 w-full text-body font-medium"
          >
            <span>使用账号密码登录</span>
            <ChevronIcon expanded={passwordOpen} />
          </button>
        </>
      ) : null}

      <div id="producer-auth-password-panel" hidden={ssoEnabled && !passwordOpen}>
        <div className="mt-4 grid gap-3">
          <label className="sr-only" htmlFor="login-username">
            用户名
          </label>
          <div className="producer-auth-field group flex h-12 items-center px-4 transition-all">
            <UserIcon />
            <input
              id="login-username"
              name="username"
              type="text"
              autoComplete="username"
              placeholder="请输入用户名"
              value={username}
              onChange={handleUsernameChange}
              aria-describedby={errorMessage ? 'login-error' : undefined}
              disabled={submitting}
              className="producer-auth-input ml-3 h-full min-w-0 flex-1 bg-transparent text-body disabled:cursor-not-allowed disabled:opacity-70"
            />
          </div>

          <label className="sr-only" htmlFor="login-password">
            密码
          </label>
          <div className="producer-auth-field group flex h-12 items-center px-4 transition-all">
            <LockIcon />
            <input
              id="login-password"
              name="password"
              type={passwordInputType}
              autoComplete="current-password"
              placeholder="请输入密码"
              value={password}
              onChange={handlePasswordChange}
              aria-describedby={errorMessage ? 'login-error' : undefined}
              disabled={submitting}
              className="producer-auth-input ml-3 h-full min-w-0 flex-1 bg-transparent text-body disabled:cursor-not-allowed disabled:opacity-70"
            />
            <button
              type="button"
              aria-label={passwordToggleLabel}
              onClick={handlePasswordVisibilityToggle}
              disabled={submitting}
              className="producer-auth-visibility-button hit-48 relative ml-3 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50"
            >
              {passwordVisible ? <EyeOffIcon /> : <EyeIcon />}
            </button>
          </div>
        </div>

        <button
          type="submit"
          disabled={submitting}
          className="producer-auth-submit-button mt-4 h-12 w-full text-body font-semibold"
        >
          {loginMutation.isPending ? '登录中' : '登录'}
        </button>
      </div>
    </form>
  )
}

/**
 * 渲染纸飞机图标（飞书登录按钮），与表单图标同一套 stroke 语言。
 *
 * @returns 纸飞机 SVG。
 */
function PaperPlaneIcon() {
  return (
    <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none">
      <title>飞书</title>
      <path
        d="m22 2-7 20-4-9-9-4Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.7"
      />
      <path
        d="M22 2 11 13"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.7"
      />
    </svg>
  )
}

/**
 * 渲染密码区展开指示图标。
 *
 * @param props - 图标属性。
 * @param props.expanded - 密码区当前是否展开。
 * @returns 向下箭头 SVG，展开时旋转 180 度。
 */
function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      aria-hidden="true"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      className={expanded ? 'rotate-180' : ''}
    >
      <title>{expanded ? '收起' : '展开'}</title>
      <path
        d="m6 9 6 6 6-6"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  )
}

/**
 * 渲染用户名输入框图标。
 *
 * @returns 用户图标 SVG。
 */
function UserIcon() {
  return (
    <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none">
      <title>用户名</title>
      <path
        d="M20 21a8 8 0 0 0-16 0M12 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.7"
      />
    </svg>
  )
}

/**
 * 渲染密码输入框图标。
 *
 * @returns 锁形图标 SVG。
 */
function LockIcon() {
  return (
    <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none">
      <title>密码</title>
      <path
        d="M7 10V8a5 5 0 0 1 10 0v2M6.5 10h11A1.5 1.5 0 0 1 19 11.5v7A1.5 1.5 0 0 1 17.5 20h-11A1.5 1.5 0 0 1 5 18.5v-7A1.5 1.5 0 0 1 6.5 10ZM12 14v2.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.7"
      />
    </svg>
  )
}

/**
 * 渲染密码可见性图标。
 *
 * @returns 眼睛图标 SVG。
 */
function EyeIcon() {
  return (
    <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none">
      <title>显示密码</title>
      <path
        d="M2.5 12s3.4-6 9.5-6 9.5 6 9.5 6-3.4 6-9.5 6-9.5-6-9.5-6Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.7"
      />
      <path
        d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.7"
      />
    </svg>
  )
}

/**
 * 渲染密码隐藏状态图标。
 *
 * @returns 带斜线的眼睛图标 SVG。
 */
function EyeOffIcon() {
  return (
    <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none">
      <title>隐藏密码</title>
      <path
        d="M3 3l18 18M10.6 10.6A2.98 2.98 0 0 0 12 15a2.98 2.98 0 0 0 1.4-.35M8.2 5.55A10.8 10.8 0 0 1 12 4.88c6.1 0 9.5 6 9.5 6a17.4 17.4 0 0 1-2.44 3.16M6.1 7.1A16.2 16.2 0 0 0 2.5 12s3.4 6 9.5 6c1.45 0 2.76-.34 3.92-.86"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.7"
      />
    </svg>
  )
}
