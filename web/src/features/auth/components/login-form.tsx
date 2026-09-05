import type { ChangeEvent, FormEvent } from 'react'
import { useState } from 'react'
import { sanitizeCueAuthNextPath, startSsoLogin, useLogin } from '@/shared/auth'
import { Icon } from '@/shared/icons'
import { Button, IconButton } from '@/shared/ui/button'
import { Input } from '@/shared/ui/field'

type LoginFormProps = {
  ssoEnabled: boolean
  initialErrorMessage?: string | undefined
  onSuccess: () => void
}

/** 飞书登录整页跳转；onSuccess 仅用于账号密码登录。初始错误在提交后清除。 */
export function LoginForm({ ssoEnabled, initialErrorMessage, onSuccess }: LoginFormProps) {
  const loginMutation = useLogin()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [passwordVisible, setPasswordVisible] = useState(false)
  const [ssoSubmitting, setSsoSubmitting] = useState(false)
  const [errorMessage, setErrorMessage] = useState(initialErrorMessage ?? '')
  // 未手动切换时，密码区根据 SSO 是否可用决定展开状态。
  const [passwordOpenOverride, setPasswordOpenOverride] = useState<boolean | null>(null)
  const passwordOpen = passwordOpenOverride ?? !ssoEnabled
  const submitting = loginMutation.isPending || ssoSubmitting
  const passwordInputType = passwordVisible ? 'text' : 'password'
  const passwordToggleLabel = passwordVisible ? '隐藏密码' : '显示密码'

  const handleUsernameChange = (event: ChangeEvent<HTMLInputElement>) => {
    setUsername(event.currentTarget.value)
  }

  const handlePasswordChange = (event: ChangeEvent<HTMLInputElement>) => {
    setPassword(event.currentTarget.value)
  }

  const handlePasswordVisibilityToggle = () => {
    setPasswordVisible((currentVisible) => !currentVisible)
  }

  const handlePasswordSectionToggle = () => {
    setPasswordOpenOverride(!passwordOpen)
  }

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
      onSuccess()
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '登录失败，请稍后重试')
    }
  }

  const handleFeishuLogin = async () => {
    setSsoSubmitting(true)
    setErrorMessage('')

    try {
      // SSO 完成后返回发起登录的站内路径。
      await startSsoLogin(sanitizeCueAuthNextPath(window.location.pathname))
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '飞书登录暂不可用，请稍后重试')
      setSsoSubmitting(false)
    }
  }

  return (
    <form
      className="w-full"
      aria-label="Cue 登录表单"
      onSubmit={(event) => {
        void handleSubmit(event)
      }}
    >
      {errorMessage ? (
        <p id="login-error" role="alert" className="cue-auth-error mb-3 text-body leading-6">
          {errorMessage}
        </p>
      ) : null}

      {ssoEnabled ? (
        <>
          <Button
            className="w-full"
            disabled={submitting}
            leadingIcon="send"
            onClick={() => {
              void handleFeishuLogin()
            }}
            variant="inverted"
          >
            {ssoSubmitting ? '正在跳转飞书…' : '使用飞书登录'}
          </Button>

          <div className="mt-6 flex items-center gap-4" aria-hidden="true">
            <span className="cue-auth-divider" />
            <span className="cue-auth-divider-label text-body-sm">其他登录方式</span>
            <span className="cue-auth-divider" />
          </div>

          <button
            type="button"
            aria-expanded={passwordOpen}
            aria-controls="cue-auth-password-panel"
            onClick={handlePasswordSectionToggle}
            className="cue-auth-secondary-toggle mt-4 w-full text-body font-medium"
          >
            <span>使用账号密码登录</span>
            <Icon decorative name={passwordOpen ? 'collapse' : 'expand'} size="md" />
          </button>
        </>
      ) : null}

      <div
        id="cue-auth-password-panel"
        className={ssoEnabled ? 'mt-4' : undefined}
        hidden={ssoEnabled && !passwordOpen}
      >
        <div className="grid gap-3">
          <label className="sr-only" htmlFor="login-username">
            用户名
          </label>
          <Input
            id="login-username"
            name="username"
            type="text"
            autoComplete="username"
            placeholder="请输入用户名"
            leadingIcon="user"
            value={username}
            onChange={handleUsernameChange}
            aria-describedby={errorMessage ? 'login-error' : undefined}
            disabled={submitting}
            className="cue-auth-autofill"
          />

          <label className="sr-only" htmlFor="login-password">
            密码
          </label>
          <Input
            id="login-password"
            name="password"
            type={passwordInputType}
            autoComplete="current-password"
            placeholder="请输入密码"
            leadingIcon="locked"
            value={password}
            onChange={handlePasswordChange}
            aria-describedby={errorMessage ? 'login-error' : undefined}
            disabled={submitting}
            className="cue-auth-autofill"
            trailingAction={
              <IconButton
                className="-mr-2 shrink-0"
                disabled={submitting}
                label={passwordToggleLabel}
                name={passwordVisible ? 'hidden' : 'preview'}
                onClick={handlePasswordVisibilityToggle}
              />
            }
          />
        </div>

        <Button
          className="mt-4 w-full"
          disabled={submitting}
          loading={loginMutation.isPending}
          type="submit"
        >
          登录
        </Button>
      </div>
    </form>
  )
}
