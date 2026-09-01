import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Bug,
  Check,
  ChevronDown,
  ChevronUp,
  CircleCheck,
  CirclePlus,
  CircleStop,
  CircleX,
  Clock3,
  Copy,
  Database,
  Ellipsis,
  ExternalLink,
  Eye,
  EyeOff,
  FilePlus2,
  FileText,
  FlaskConical,
  Folder,
  Hand,
  Image,
  Lightbulb,
  ListChecks,
  Mail,
  LockKeyhole,
  LogOut,
  PanelLeft,
  PanelRight,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings,
  Trash2,
  TriangleAlert,
  User,
  Video,
  X,
  ZoomIn,
} from 'lucide-react'
import type { LucideProps } from 'lucide-react'
import { cn } from '@/shared/lib/utils'

/**
 * 加载图形照 kimi 网页版的 ui-spinner 复刻：底色轨道环 + 墨色圆弧（dasharray 56 / offset 38，
 * 可见弧约三分之一圈），调用处的 animate-spin 负责转。轨道色取发丝边框 token，深浅自动换向。
 */
const LoadingGlyph = ({ strokeWidth: _strokeWidth, ...props }: LucideProps) => (
  <svg fill="none" viewBox="0 0 24 24" {...props}>
    <circle
      cx={12}
      cy={12}
      r={9}
      strokeWidth={2.2}
      style={{ stroke: 'var(--color-chat-hairline)' }}
    />
    <circle
      cx={12}
      cy={12}
      r={9}
      stroke="currentColor"
      strokeDasharray="56 56"
      strokeDashoffset={38}
      strokeLinecap="round"
      strokeWidth={2.2}
    />
  </svg>
)

// 键名按用途起，不按图形起：调用点写 name="close" 而不是 name="x"，
// 换掉底层图形时只改这张表。
const ICONS = {
  add: Plus,
  'add-file': FilePlus2,
  back: ArrowLeft,
  'chat-new': CirclePlus,
  check: Check,
  close: X,
  collapse: ChevronUp,
  confirm: Hand,
  copy: Copy,
  debug: Bug,
  delete: Trash2,
  duration: Clock3,
  edit: Pencil,
  experiment: FlaskConical,
  expand: ChevronDown,
  external: ExternalLink,
  failed: CircleX,
  file: FileText,
  folder: Folder,
  hidden: EyeOff,
  image: Image,
  library: Database,
  loading: LoadingGlyph,
  mail: Mail,
  locked: LockKeyhole,
  logout: LogOut,
  more: Ellipsis,
  next: ArrowRight,
  'panel-left': PanelLeft,
  'panel-right': PanelRight,
  play: Play,
  preview: Eye,
  refresh: RefreshCw,
  search: Search,
  send: Send,
  'send-up': ArrowUp,
  settings: Settings,
  stopped: CircleStop,
  success: CircleCheck,
  task: ListChecks,
  thinking: Lightbulb,
  'to-bottom': ArrowDown,
  user: User,
  video: Video,
  warning: TriangleAlert,
  zoom: ZoomIn,
} as const

export type IconName = keyof typeof ICONS

export type IconSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl'

// 尺寸走 CSS 而不是 lucide 的 size 属性：SVG 的 width/height 是表现属性，
// 类名里的 --icon-* 会盖过它，档位因此只有规范里的五级。
const SIZE_CLASS: Record<IconSize, string> = {
  xs: 'size-(--icon-xs)',
  sm: 'size-(--icon-sm)',
  md: 'size-(--icon-md)',
  lg: 'size-(--icon-lg)',
  xl: 'size-(--icon-xl)',
}

type IconProps = {
  name: IconName
  size?: IconSize
  className?: string
} & (
  | { label: string; decorative?: never }
  // 纯装饰图标要显式声明，缺省不当作装饰处理，避免读屏用户丢掉唯一的含义载体
  | { decorative: true; label?: never }
)

export function Icon({ name, size = 'md', className, ...intent }: IconProps) {
  const label = 'label' in intent ? intent.label : undefined
  if (!label && !('decorative' in intent)) {
    throw new Error(`Icon "${name}" 缺少 label：语义图标必须传 label，装饰图标必须传 decorative`)
  }

  const Glyph = ICONS[name]
  return (
    <Glyph
      aria-hidden={label ? undefined : true}
      aria-label={label}
      className={cn(SIZE_CLASS[size], className)}
      focusable={false}
      role={label ? 'img' : undefined}
      strokeWidth={2}
    />
  )
}
