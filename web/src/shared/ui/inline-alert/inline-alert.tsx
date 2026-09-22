/** 就地播报的错误横幅：一句话加一个可选动作，不占弹窗也不抢焦点。 */

import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'

type InlineAlertProps = {
  message: string
  action?: { label: string; onClick: () => void }
  className?: string
}

export function InlineAlert({ action, className, message }: InlineAlertProps) {
  return (
    <p
      className={cn('flex flex-wrap items-center gap-2 text-body-sm text-error', className)}
      role="alert"
    >
      {message}
      {action === undefined ? null : (
        <Button onClick={action.onClick} size="md" variant="ghost">
          {action.label}
        </Button>
      )}
    </p>
  )
}
