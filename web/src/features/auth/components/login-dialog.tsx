import { useQuery } from '@tanstack/react-query'
import { AUTH_QUERY_KEY_ROOT, probeSsoLoginEnabled } from '@/shared/auth'
import { DialogBody, DialogHeader, DialogRoot, DialogSurface } from '@/shared/ui/dialog'
import { InlineAlert } from '@/shared/ui/inline-alert'
import { ssoErrorMessageOf } from '../sso-error'
import { LoginForm } from './login-form'

type LoginDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  ssoErrorCode?: string | undefined
}

/** 登录成功后就地关闭弹窗；onOpenChange 也用于遮罩、Esc 与关闭按钮。 */
export function LoginDialog({ open, onOpenChange, ssoErrorCode }: LoginDialogProps) {
  const ssoErrorMessage = ssoErrorCode ? ssoErrorMessageOf(ssoErrorCode) : undefined
  // 只缓存「开 / 关」这类确定答案；探测出错时没有数据，下次打开弹窗会重新探测。
  const ssoProbe = useQuery({
    enabled: open,
    queryFn: probeSsoLoginEnabled,
    queryKey: [AUTH_QUERY_KEY_ROOT, 'sso-enabled'],
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
