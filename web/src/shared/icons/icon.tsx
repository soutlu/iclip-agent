import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  BookOpen,
  Bot,
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
  Ellipsis,
  ExternalLink,
  Eye,
  EyeOff,
  FilePlus2,
  FileText,
  FlaskConical,
  Folder,
  Hand,
  History,
  Image,
  LayoutGrid,
  Lightbulb,
  ListChecks,
  Mail,
  LockKeyhole,
  LogOut,
  Maximize2,
  Minimize2,
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

/**
 * 复制图形照 WorkBuddy 终态栏原版复刻：16×16 画布上 strokeWidth 1.3 的圆角双方块，
 * 第二个 path 是 back rect 的描边。线宽是图形自带的一部分，不吃 Icon 统一的 strokeWidth。
 */
const CopyGlyph = ({ strokeWidth: _strokeWidth, ...props }: LucideProps) => (
  <svg fill="none" viewBox="0 0 16 16" {...props}>
    <path
      d="M13.3334 5.33301H6.66671C5.93033 5.33301 5.33337 5.92996 5.33337 6.66634V13.333C5.33337 14.0694 5.93033 14.6663 6.66671 14.6663H13.3334C14.0698 14.6663 14.6667 14.0694 14.6667 13.333V6.66634C14.6667 5.92996 14.0698 5.33301 13.3334 5.33301Z"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.3}
    />
    <path
      d="M2.66671 10.6663C1.93337 10.6663 1.33337 10.0663 1.33337 9.33301V2.66634C1.33337 1.93301 1.93337 1.33301 2.66671 1.33301H9.33337C10.0667 1.33301 10.6667 1.93301 10.6667 2.66634"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.3}
    />
  </svg>
)

/**
 * 消耗图形照 WorkBuddy 的 credit 钻石复刻：12×12 画布，path 转 45° 后成四角星，
 * evenodd 让内圈星形镂空。原版还叠了一层全画布 clipPath，无实际裁剪作用，省去。
 */
const CreditGlyph = ({ strokeWidth: _strokeWidth, ...props }: LucideProps) => (
  <svg fill="none" viewBox="0 0 12 12" {...props}>
    <path
      d="M8.071 5.8145Q7.6114 4.3123 8.0711 2.8101Q8.1299 2.618 8.3724 2.0022L8.3724 2.0022Q8.3769 1.9909 8.3859 1.9681Q8.5513 1.5482 8.5709 1.4004Q8.6478 0.8187 8.2271 0.3979Q7.8063 -0.0228 7.2246 0.0541Q7.0768 0.0737 6.6569 0.2391Q6.635 0.2478 6.6228 0.2526Q6.007 0.4951 5.8148 0.5539Q4.3127 1.0136 2.8106 0.554Q2.6185 0.4952 2.002 0.2524Q1.9907 0.248 1.968 0.239Q1.5485 0.0737 1.4008 0.0541Q0.8189 -0.0229 0.398 0.398Q-0.0228 0.8189 0.0544 1.4008Q0.0739 1.5485 0.2393 1.968Q0.2482 1.9906 0.2527 2.002L0.2527 2.002Q0.4951 2.6174 0.5539 2.8094Q1.0141 4.3122 0.554 5.8152Q0.4952 6.0071 0.2527 6.6227Q0.2486 6.6332 0.2393 6.6568Q0.0739 7.0764 0.0543 7.2242Q-0.0227 7.8061 0.3981 8.2269Q0.8189 8.6477 1.4008 8.5707Q1.5486 8.5511 1.9683 8.3857Q1.9895 8.3773 2.0024 8.3722Q2.6178 8.1298 2.8098 8.071Q4.3127 7.6108 5.8156 8.0711Q6.0076 8.1299 6.623 8.3723L6.657 8.3857Q7.0765 8.5511 7.2242 8.5706Q7.8061 8.6478 8.227 8.227Q8.6479 7.8061 8.5708 7.2242Q8.5513 7.0765 8.3857 6.6564Q8.3767 6.6335 8.3723 6.6224L8.3723 6.6223Q8.1298 6.0066 8.071 5.8145ZM7.4443 1.6367Q7.1875 2.2887 7.1173 2.5182Q6.5682 4.3122 7.1172 6.1063Q7.1874 6.3358 7.4442 6.9879L7.4442 6.9879Q7.4489 6.9998 7.4577 7.0221Q7.5784 7.3285 7.582 7.3552Q7.5944 7.4489 7.5217 7.5216Q7.449 7.5942 7.3553 7.5818Q7.3287 7.5783 7.0228 7.4577Q6.9974 7.4477 6.9886 7.4442Q6.337 7.1875 6.1077 7.1173Q4.3127 6.5676 2.5177 7.1172Q2.2885 7.1874 1.6368 7.4441Q1.6258 7.4485 1.6025 7.4576Q1.2965 7.5783 1.2698 7.5818Q1.1761 7.5942 1.1034 7.5215Q1.0308 7.4489 1.0432 7.3552Q1.0467 7.3285 1.1673 7.0226Q1.1765 6.9991 1.1808 6.9883Q1.4376 6.3365 1.5078 6.1072Q2.0573 4.3122 1.5077 2.5173Q1.4375 2.288 1.1808 1.6364L1.1808 1.6364Q1.1762 1.6248 1.1673 1.6022Q1.0467 1.2963 1.0432 1.2697Q1.0308 1.1759 1.1034 1.1033Q1.1761 1.0306 1.2698 1.043Q1.2964 1.0465 1.6023 1.1671Q1.6246 1.1759 1.6365 1.1805Q2.2893 1.4376 2.5187 1.5078Q4.3128 2.0568 6.1068 1.5078Q6.3362 1.4375 6.9883 1.1807Q7 1.1761 7.0226 1.1672Q7.3287 1.0465 7.3554 1.043Q7.4491 1.0306 7.5217 1.1033Q7.5944 1.1759 7.582 1.2696Q7.5785 1.2963 7.4578 1.6024Q7.449 1.6247 7.4443 1.6366L7.4443 1.6367Z"
      fill="currentColor"
      fillRule="evenodd"
      transform="matrix(0.707107 0.707107 -0.707107 0.707107 6.00073 -0.0995307)"
    />
  </svg>
)

// 键名按用途起，不按图形起：调用点写 name="close" 而不是 name="x"，
// 换掉底层图形时只改这张表。
const ICONS = {
  add: Plus,
  'add-file': FilePlus2,
  agent: Bot,
  back: ArrowLeft,
  'chat-new': CirclePlus,
  check: Check,
  close: X,
  collapse: ChevronUp,
  confirm: Hand,
  copy: CopyGlyph,
  credit: CreditGlyph,
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
  grid: LayoutGrid,
  hidden: EyeOff,
  history: History,
  image: Image,
  library: Database,
  loading: LoadingGlyph,
  mail: Mail,
  locked: LockKeyhole,
  logout: LogOut,
  more: Ellipsis,
  'maximize-panel': Maximize2,
  'minimize-panel': Minimize2,
  next: ArrowRight,
  'panel-left': PanelLeft,
  'panel-right': PanelRight,
  play: Play,
  preview: Eye,
  reference: BookOpen,
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
