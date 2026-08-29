import { useQuery } from '@tanstack/react-query'
import { probeSsoLoginEnabled } from '@/shared/auth'
import { DialogBody, DialogHeader, DialogRoot, DialogSurface } from '@/shared/ui/dialog'
import { LoginForm } from './login-form'

// SSO 落地路由通过 ?ssoError= 传回的错误码 → 用户可读文案（SSO 通道即飞书登录）。
const SSO_ERROR_MESSAGES: Record<string, string> = {
  forbidden: '账号已停用，请联系管理员开通',
  invalid: '飞书登录会话无效或已过期，请重新登录',
  missing: '缺少飞书登录凭证，请重新发起登录',
  unavailable: '飞书登录暂不可用，请稍后重试或使用账号密码登录',
}

type LoginDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  ssoErrorCode?: string | undefined
}

/**
 * 登录弹窗：用户点到需要登录的动作时弹出，登录成功就地关闭，不离开当前页面。
 *
 * @param props - 弹窗属性。
 * @param props.open - 是否展开。
 * @param props.onOpenChange - 展开状态变化回调（遮罩、Esc、关闭键、登录成功都会触发）。
 * @param props.ssoErrorCode - SSO 回跳失败时带回的错误码，展示在表单顶部。
 * @returns 登录弹窗。
 */
export function LoginDialog({ open, onOpenChange, ssoErrorCode }: LoginDialogProps) {
  const ssoErrorMessage = ssoErrorCode
    ? (SSO_ERROR_MESSAGES[ssoErrorCode] ?? 'SSO 登录失败，请重试')
    : undefined
  // 探测后端是否开启企业 SSO，决定弹窗里是否展示飞书入口。
  const { data: ssoEnabled = false } = useQuery({
    enabled: open,
    queryFn: probeSsoLoginEnabled,
    queryKey: ['auth', 'sso-enabled'],
    staleTime: Number.POSITIVE_INFINITY,
  })

  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogSurface aria-label="登录 Producer" className="max-w-[420px]">
        <DialogHeader closeLabel="关闭登录" title="欢迎登录 Producer" />
        <DialogBody>
          <LoginForm
            ssoEnabled={ssoEnabled}
            initialErrorMessage={ssoErrorMessage}
            onSuccess={() => onOpenChange(false)}
          />
        </DialogBody>
      </DialogSurface>
    </DialogRoot>
  )
}
