import { useQuery } from '@tanstack/react-query'
import { probeSsoLoginEnabled } from '@/shared/auth'
import { DialogBody, DialogHeader, DialogRoot, DialogSurface } from '@/shared/ui/dialog'
import { InlineAlert } from '@/shared/ui/inline-alert'
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

/** 登录成功后就地关闭弹窗；onOpenChange 也用于遮罩、Esc 与关闭按钮。 */
export function LoginDialog({ open, onOpenChange, ssoErrorCode }: LoginDialogProps) {
  const ssoErrorMessage = ssoErrorCode
    ? (SSO_ERROR_MESSAGES[ssoErrorCode] ?? 'SSO 登录失败，请重试')
    : undefined
  // 只缓存「开 / 关」这类确定答案；探测出错时没有数据，下次打开弹窗会重新探测。
  const ssoProbe = useQuery({
    enabled: open,
    queryFn: probeSsoLoginEnabled,
    queryKey: ['auth', 'sso-enabled'],
    staleTime: Number.POSITIVE_INFINITY,
  })

  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogSurface aria-label="登录 Cue" className="max-w-[420px]">
        <DialogHeader closeLabel="关闭登录" title="欢迎登录 Cue" />
        <DialogBody>
          {ssoProbe.isError ? (
            <InlineAlert
              action={{ label: '重试', onClick: () => void ssoProbe.refetch() }}
              className="mb-3"
              message="飞书登录暂不可用，请使用账号密码登录"
            />
          ) : null}
          <LoginForm
            ssoEnabled={ssoProbe.data ?? false}
            initialErrorMessage={ssoErrorMessage}
            onSuccess={() => onOpenChange(false)}
          />
        </DialogBody>
      </DialogSurface>
    </DialogRoot>
  )
}
