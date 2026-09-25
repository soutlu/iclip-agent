import { cn } from '@/shared/lib/utils'

/** 作者头像：用户名的首字压在圆底上，尺寸与字号由调用方给。 */
export function AuthorAvatar({ name, className }: { name: string; className: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'grid shrink-0 place-items-center rounded-full bg-surface-container-high text-on-surface',
        className,
      )}
    >
      {Array.from(name)[0]?.toLocaleUpperCase()}
    </span>
  )
}
