import {
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
  Database,
  ExternalLink,
  Eye,
  EyeOff,
  FileText,
  FlaskConical,
  Folder,
  Hand,
  Image,
  ListChecks,
  LoaderCircle,
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
  TriangleAlert,
  User,
  Video,
  X,
  ZoomIn,
} from 'lucide-react'
import { cn } from '@/shared/lib/utils'

// 键名按用途起，不按图形起：调用点写 name="close" 而不是 name="x"，
// 换掉底层图形时只改这张表。
const ICONS = {
  add: Plus,
  back: ArrowLeft,
  'chat-new': CirclePlus,
  check: Check,
  close: X,
  collapse: ChevronUp,
  confirm: Hand,
  debug: Bug,
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
  loading: LoaderCircle,
  locked: LockKeyhole,
  logout: LogOut,
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
  task: ListChecks,
  success: CircleCheck,
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
