/** 对话与媒体生成任务的状态角标。只画调用方给的状态，不查数据、不汇总任务。 */

import { cva } from 'class-variance-authority'
import { Icon, type IconName } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'

export type ConversationBadgeStatus =
  'idle' | 'running' | 'approval' | 'question' | 'failed' | 'completed' | 'aborted'

export type MediaBadgeStatus = 'idle' | 'queued' | 'running' | 'failed' | 'completed'

type Tone = 'neutral' | 'success' | 'warning' | 'danger'

/** 右下角叠标：小圆里的对勾或叉、排队时钟、呼吸圆点。 */
type Marker = 'check' | 'close' | 'clock' | 'dot'

type BadgeSpec = {
  label: string
  tone: Tone
  icon: IconName
  /** 主图形旋转；只有对话进行中用。 */
  spin?: true
  marker?: Marker
}

const CONVERSATION: Record<Exclude<ConversationBadgeStatus, 'idle'>, BadgeSpec> = {
  aborted: { icon: 'stop', label: '已中止', tone: 'neutral' },
  approval: { icon: 'alert', label: '等待审批', tone: 'warning' },
  completed: { icon: 'check', label: '已完成', tone: 'success' },
  failed: { icon: 'alert', label: '上次失败', tone: 'danger' },
  question: { icon: 'alert', label: '等待回答', tone: 'warning' },
  running: { icon: 'spinner', label: '进行中', spin: true, tone: 'success' },
}

const MEDIA: Record<Exclude<MediaBadgeStatus, 'idle'>, Omit<BadgeSpec, 'icon'>> = {
  completed: { label: '已完成', marker: 'check', tone: 'success' },
  failed: { label: '生成失败', marker: 'close', tone: 'danger' },
  queued: { label: '排队中', marker: 'clock', tone: 'neutral' },
  running: { label: '生成中', marker: 'dot', tone: 'success' },
}

const MEDIA_KIND: Record<'image' | 'video', { icon: IconName; name: string }> = {
  image: { icon: 'image', name: '图片' },
  video: { icon: 'video', name: '视频' },
}

const MARKER_ICON: Record<Exclude<Marker, 'dot'>, IconName> = {
  check: 'check',
  clock: 'duration',
  close: 'close',
}

const badgeClass = cva('status-badge inline-flex shrink-0 items-center', {
  compoundVariants: [
    {
      appearance: 'label',
      class: 'bg-secondary-container text-on-secondary-container',
      tone: 'neutral',
    },
    {
      appearance: 'label',
      class: 'bg-primary-container text-on-primary-container',
      tone: 'success',
    },
    {
      appearance: 'label',
      class: 'bg-warning-container text-on-warning-container',
      tone: 'warning',
    },
    { appearance: 'label', class: 'bg-error-container text-on-error-container', tone: 'danger' },
  ],
  variants: {
    appearance: {
      icon: '',
      label:
        'h-(--control-height-xs) gap-1 rounded-full pr-2 pl-0.5 text-label font-medium whitespace-nowrap',
    },
    tone: {
      danger: 'text-error',
      neutral: 'text-on-surface-variant',
      success: 'text-primary',
      warning: 'text-warning',
    },
  },
})

type SharedProps = {
  /** 纯图标放标题旁；带文字用在要直接读出状态的地方。 */
  appearance?: 'icon' | 'label'
  /** 替代默认文案，如帧上的「有新结果」。 */
  text?: string
  /** 浮层里的补充说明，空白忽略。 */
  detail?: string
  className?: string
}

export type StatusBadgeProps = SharedProps &
  (
    | { kind: 'conversation'; status: ConversationBadgeStatus }
    | { kind: 'image' | 'video'; status: MediaBadgeStatus }
  )

const specOf = (props: StatusBadgeProps): BadgeSpec | undefined => {
  if (props.status === 'idle') return undefined
  if (props.kind === 'conversation') return CONVERSATION[props.status]
  return { ...MEDIA[props.status], icon: MEDIA_KIND[props.kind].icon }
}

/**
 * `idle` 不渲染。纯图标以 `aria-label` 命名（媒体类带「视频 / 图片」前缀），悬停出浮层；
 * 带文字以可见文字命名，有 `detail` 时才出浮层。不进 Tab 序。
 */
export function StatusBadge(props: StatusBadgeProps) {
  const spec = specOf(props)
  if (spec === undefined) return null

  const { appearance = 'icon', className, detail, text } = props
  const label = text ?? spec.label
  const name = props.kind === 'conversation' ? label : `${MEDIA_KIND[props.kind].name}${label}`
  const explanation = detail?.trim() || undefined
  const media = props.kind !== 'conversation'

  const glyph = (
    <span aria-hidden className="status-badge-glyph" data-marker={spec.marker}>
      <Icon
        className={cn(
          'status-badge-main',
          media && appearance === 'icon' && 'text-on-surface-variant',
          spec.spin && 'motion-safe:animate-spin',
        )}
        decorative
        name={spec.icon}
        size="md"
      />
      {spec.marker === undefined ? null : (
        <span
          className={cn(
            'status-badge-marker',
            spec.marker === 'dot' && 'motion-safe:animate-pulse',
          )}
          data-marker={spec.marker}
        >
          {spec.marker === 'dot' ? null : <Icon decorative name={MARKER_ICON[spec.marker]} />}
        </span>
      )}
    </span>
  )

  const badge =
    appearance === 'icon' ? (
      <span
        aria-label={name}
        className={cn(badgeClass({ appearance, tone: spec.tone }), className)}
        data-appearance={appearance}
        data-tone={spec.tone}
        role="img"
      >
        {glyph}
      </span>
    ) : (
      <span
        className={cn(badgeClass({ appearance, tone: spec.tone }), className)}
        data-appearance={appearance}
        data-tone={spec.tone}
      >
        {glyph}
        <span>{label}</span>
      </span>
    )

  if (appearance === 'label' && explanation === undefined) return badge
  return (
    <TooltipRoot>
      <TooltipTrigger asChild>{badge}</TooltipTrigger>
      <TooltipContent side="top">
        <span className="block font-medium">{name}</span>
        {explanation === undefined ? null : (
          <span className="block text-caption text-inverse-on-surface/80">{explanation}</span>
        )}
      </TooltipContent>
    </TooltipRoot>
  )
}
