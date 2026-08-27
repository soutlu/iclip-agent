import type { HTMLAttributes, MouseEvent } from 'react'
import { useCallback } from 'react'
import { cn } from '@/shared/lib/utils'
import { usePopupAnchor } from '@/shared/ui/popup/usePopupAnchor'
import { SettingsPopupContent } from './SettingsPopupContent'

export type VideoGenerationMode = 'clip' | 'full'
export type VideoGenerationAspectRatio = '21:9' | '16:9' | '4:3' | '1:1' | '3:4' | '9:16'
export type VideoGenerationModel = 'mmt-seedance-2-0'
export type VideoGenerationSeconds = number

export interface VideoGenerationSettings {
  aspectRatio: VideoGenerationAspectRatio
  mode: VideoGenerationMode
  model: VideoGenerationModel
  quality: '720p'
  seconds: VideoGenerationSeconds
}

interface VideoGenerationSettingsControlProps {
  className?: string
  onOpenChange?: (open: boolean) => void
  onSettingsChange: (settings: VideoGenerationSettings) => void
  panelAlign?: 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end'
  settings: VideoGenerationSettings
}

interface AspectRatioOption {
  label: VideoGenerationAspectRatio
  value: VideoGenerationAspectRatio
}

export const VIDEO_GENERATION_ASPECT_RATIO_VALUES = [
  '21:9',
  '16:9',
  '4:3',
  '1:1',
  '3:4',
  '9:16',
] as const satisfies readonly VideoGenerationAspectRatio[]
const ASPECT_RATIO_OPTIONS: AspectRatioOption[] = VIDEO_GENERATION_ASPECT_RATIO_VALUES.map(
  (value) => ({
    label: value,
    value,
  }),
)

const ASPECT_RATIO_GLYPH_SIZE: Record<
  VideoGenerationAspectRatio,
  { height: number; width: number }
> = {
  '1:1': { height: 20, width: 20 },
  '3:4': { height: 22, width: 16 },
  '4:3': { height: 18, width: 24 },
  '9:16': { height: 24, width: 14 },
  '16:9': { height: 16, width: 26 },
  '21:9': { height: 14, width: 30 },
}
const DURATION_MIN_SECONDS = 4
const DURATION_MAX_SECONDS = 15
const DURATION_DEFAULT_SECONDS = 5
const VIDEO_GENERATION_ASPECT_RATIO_OPTIONS = VIDEO_GENERATION_ASPECT_RATIO_VALUES.map((value) => {
  const [width, height] = value.split(':').map(Number)

  if (!width || !height) {
    throw new Error(`视频比例配置非法：${value}`)
  }

  return {
    ratio: width / height,
    value,
  }
})

export const DEFAULT_VIDEO_GENERATION_MODEL: VideoGenerationModel = 'mmt-seedance-2-0'

export const DEFAULT_VIDEO_GENERATION_SETTINGS: VideoGenerationSettings = {
  aspectRatio: '16:9',
  mode: 'clip',
  model: DEFAULT_VIDEO_GENERATION_MODEL,
  quality: '720p',
  seconds: DURATION_DEFAULT_SECONDS,
}

/**
 * 将任意时长值规范到视频设置允许的整数秒数范围内。
 *
 * @param value - 原始秒数。
 * @returns 4 到 15 秒之间的整数秒数。
 */
export const clampVideoGenerationSeconds = (value: number): VideoGenerationSeconds =>
  Math.min(DURATION_MAX_SECONDS, Math.max(DURATION_MIN_SECONDS, Math.round(value)))

/**
 * 将图片实际宽高映射到当前视频 provider 支持的最近比例。
 *
 * @param width - 图片自然宽度。
 * @param height - 图片自然高度。
 * @returns 最近的受支持视频比例。
 */
export const closestVideoGenerationAspectRatio = (
  width: number,
  height: number,
): VideoGenerationAspectRatio => {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('图片尺寸必须是正数。')
  }

  const imageRatio = width / height
  // 选项列表由常量映射生成，恒非空。
  let closest = VIDEO_GENERATION_ASPECT_RATIO_OPTIONS[0]!
  let closestDistance = Math.abs(Math.log(imageRatio / closest.ratio))

  for (const option of VIDEO_GENERATION_ASPECT_RATIO_OPTIONS.slice(1)) {
    const distance = Math.abs(Math.log(imageRatio / option.ratio))

    if (distance < closestDistance) {
      closest = option
      closestDistance = distance
    }
  }

  return closest.value
}

/**
 * 渲染上传素材后的生成参数摘要。
 *
 * @param props - 摘要属性。
 * @param props.className - 额外样式。
 * @param props.settings - 当前视频生成设置。
 * @returns 与设置按钮同排的参数状态。
 */
export function VideoGenerationSettingsSummary({
  className = '',
  settings,
  ...restProps
}: HTMLAttributes<HTMLDivElement> & { settings: VideoGenerationSettings }) {
  return (
    <div
      className={cn(
        'flex max-w-[min(620px,calc(100vw-180px))] min-w-0 items-center gap-3 overflow-hidden text-body-sm leading-none font-semibold text-on-background md:text-body',
        className,
      )}
      data-video-generation-settings-summary="true"
      title={`${settings.model} | ${settings.aspectRatio} | ${settings.seconds.toString()}s | ${settings.quality}`}
      {...restProps}
    >
      <span className="min-w-0 truncate">{settings.model}</span>
      <SummaryDivider />
      <span className="shrink-0">{settings.aspectRatio}</span>
      <SummaryDivider />
      <span className="shrink-0">{settings.seconds.toString()}s</span>
      <SummaryDivider />
      <span className="shrink-0">{settings.quality}</span>
    </div>
  )
}

/**
 * 渲染视频生成参数入口与浮层。
 *
 * @param props - 视频生成参数控件属性。
 * @param props.className - 入口按钮附加样式。
 * @param props.onOpenChange - 浮层打开状态变化回调。
 * @param props.onSettingsChange - 用户选择参数后的状态回调。
 * @param props.panelAlign - 浮层相对入口按钮的展开方向。
 * @param props.settings - 当前视频生成参数。
 * @returns 可复用于首页 video 模式和 Direct Canvas composer 的设置控件。
 */
export default function VideoGenerationSettingsControl({
  className = '',
  onOpenChange,
  onSettingsChange,
  panelAlign = 'top-end',
  settings,
}: VideoGenerationSettingsControlProps) {
  const { anchorRect, open, setOpen, triggerRef, updateAnchorRect } =
    usePopupAnchor<HTMLButtonElement>()

  /**
   * 关闭视频生成参数浮层。
   *
   * @returns 无返回值。
   */
  const closePanel = useCallback(() => {
    setOpen(false)
    onOpenChange?.(false)
  }, [onOpenChange, setOpen])

  /**
   * 切换视频生成参数浮层。
   *
   * @param event - 入口按钮点击事件。
   * @returns 无返回值。
   */
  const handleTriggerClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    const nextOpen = !open

    if (nextOpen) {
      updateAnchorRect()
    }

    setOpen(nextOpen)
    onOpenChange?.(nextOpen)
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label="视频生成设置"
        className={cn(
          'surface-button hit-48 relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
          open ? 'bg-state-active' : '',
          className,
        )}
        data-video-generation-settings-button="true"
        onClick={handleTriggerClick}
        onPointerDown={(event) => event.stopPropagation()}
        title="视频生成设置"
      >
        <SlidersIcon />
      </button>

      <SettingsPopupContent
        align={panelAlign}
        anchorRect={anchorRect}
        aria-label="视频生成设置"
        onDismiss={closePanel}
        open={open}
        role="dialog"
      >
        <section className="flex flex-col gap-2.5">
          <h2 className="text-body-sm font-semibold text-on-surface-variant">Model and quality</h2>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <button
              type="button"
              aria-label="视频生成模型 mmt-seedance-2-0"
              aria-pressed={settings.model === DEFAULT_VIDEO_GENERATION_MODEL}
              className="flex h-10 min-w-0 items-center justify-between gap-3 rounded-lg border border-transparent bg-top-layer px-4 text-left text-body-sm font-semibold text-on-background"
              onClick={() =>
                onSettingsChange({ ...settings, model: DEFAULT_VIDEO_GENERATION_MODEL })
              }
            >
              <span className="min-w-0 truncate">mmt-seedance-2-0</span>
            </button>
            <button
              type="button"
              aria-label="视频画质 720p"
              className="flex h-10 min-w-0 cursor-not-allowed items-center justify-between gap-3 rounded-lg border border-transparent bg-[color-mix(in_srgb,var(--color-on-surface-variant)_11%,transparent)] px-4 text-left text-body-sm font-semibold text-on-background opacity-80"
              disabled
            >
              <span>{settings.quality}</span>
              <ChevronDownIcon />
            </button>
          </div>
        </section>

        <section className="flex flex-col gap-2.5">
          <h2 className="text-body-sm font-semibold text-on-surface-variant">Aspect ratio</h2>
          <div className="grid grid-cols-4 gap-1.5 rounded-xl bg-[color-mix(in_srgb,var(--color-on-surface-variant)_11%,transparent)] p-1.5 sm:grid-cols-7">
            {ASPECT_RATIO_OPTIONS.map((option) => (
              <AspectRatioButton
                key={option.value}
                onSelect={onSettingsChange}
                option={option}
                selected={settings.aspectRatio === option.value}
                settings={settings}
              />
            ))}
          </div>
        </section>

        <section className="flex flex-col gap-2.5">
          <h2 className="text-body-sm font-semibold text-on-surface-variant">Duration</h2>
          <DurationSlider onSettingsChange={onSettingsChange} settings={settings} />
        </section>
      </SettingsPopupContent>
    </>
  )
}

/**
 * 渲染单个画幅比例按钮。
 *
 * @param props - 画幅按钮属性。
 * @param props.onSelect - 选择比例后的回调。
 * @param props.option - 当前比例选项。
 * @param props.selected - 当前选项是否选中。
 * @param props.settings - 当前视频生成参数。
 * @returns 画幅比例按钮。
 */
function AspectRatioButton({
  onSelect,
  option,
  selected,
  settings,
}: {
  onSelect: (settings: VideoGenerationSettings) => void
  option: AspectRatioOption
  selected: boolean
  settings: VideoGenerationSettings
}) {
  return (
    <button
      type="button"
      aria-label={`选择画幅比例 ${option.label}`}
      aria-pressed={selected}
      className={cn(
        'flex min-h-14 min-w-0 flex-col items-center justify-center gap-1.5 rounded-lg px-2 text-body-sm font-semibold transition-all ui-motion-s',
        selected
          ? 'bg-top-layer text-on-background'
          : 'text-on-surface-variant hover:bg-hover active:scale-95',
      )}
      onClick={() => onSelect({ ...settings, aspectRatio: option.value })}
    >
      <AspectRatioGlyph value={option.value} />
      <span className="leading-none">{option.label}</span>
    </button>
  )
}

/**
 * 渲染 4 到 15 秒的视频时长滑块。
 *
 * @param props - 时长滑块属性。
 * @param props.onSettingsChange - 参数更新回调。
 * @param props.settings - 当前视频生成参数。
 * @returns 整数秒数滑块控件。
 */
function DurationSlider({
  onSettingsChange,
  settings,
}: {
  onSettingsChange: (settings: VideoGenerationSettings) => void
  settings: VideoGenerationSettings
}) {
  const seconds = clampVideoGenerationSeconds(settings.seconds)
  const progress =
    ((seconds - DURATION_MIN_SECONDS) / (DURATION_MAX_SECONDS - DURATION_MIN_SECONDS)) * 100

  return (
    <div className="rounded-xl bg-[color-mix(in_srgb,var(--color-on-surface-variant)_11%,transparent)] px-4 py-3">
      <div className="grid grid-cols-[28px_minmax(0,1fr)_32px_52px] items-center gap-3">
        <span className="text-label font-semibold text-on-surface-variant">
          {DURATION_MIN_SECONDS}s
        </span>

        <div className="relative h-8 min-w-0">
          <input
            id="video-generation-duration-slider"
            type="range"
            min={DURATION_MIN_SECONDS}
            max={DURATION_MAX_SECONDS}
            step={1}
            value={seconds}
            aria-label="选择视频时长"
            aria-valuetext={`${seconds}s`}
            className="peer layer-local-1 absolute inset-0 h-full w-full cursor-pointer opacity-0"
            data-video-duration-slider="true"
            onChange={(event) =>
              onSettingsChange({
                ...settings,
                seconds: clampVideoGenerationSeconds(Number(event.currentTarget.value)),
              })
            }
          />
          <span
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 right-0 left-0 h-2 -translate-y-1/2 rounded-full bg-[color-mix(in_srgb,var(--color-on-surface-variant)_24%,transparent)]"
          />
          <span
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-0 h-2 -translate-y-1/2 rounded-full bg-top-layer"
            style={{ width: `${progress}%` }}
          />
          <span
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 size-[22px] -translate-x-1/2 -translate-y-1/2 rounded-full border border-[color-mix(in_srgb,var(--color-on-surface-variant)_18%,transparent)] bg-top-layer shadow-[var(--shadow-2)] peer-focus-visible:ring-4 peer-focus-visible:ring-state-active"
            style={{ left: `${progress}%` }}
          />
        </div>

        <span className="text-right text-label font-semibold text-on-surface-variant">
          {DURATION_MAX_SECONDS}s
        </span>
        <output
          aria-live="polite"
          className="rounded-lg bg-top-layer px-3 py-1.5 text-center text-body-sm font-semibold text-on-background"
          htmlFor="video-generation-duration-slider"
        >
          {seconds}s
        </output>
      </div>
    </div>
  )
}

/**
 * 渲染画幅比例图形。
 *
 * @param props - 图形属性。
 * @param props.value - 当前画幅比例。
 * @returns 与比例近似的线框图形。
 */
function AspectRatioGlyph({ value }: { value: VideoGenerationAspectRatio }) {
  const size = ASPECT_RATIO_GLYPH_SIZE[value]

  return (
    <span
      aria-hidden="true"
      className="inline-flex shrink-0 rounded-xs border-2 border-current"
      style={{ height: size.height, width: size.width }}
    />
  )
}

/**
 * 渲染参数摘要分隔线。
 *
 * @returns 细竖线。
 */
function SummaryDivider() {
  return (
    <span
      aria-hidden="true"
      className="h-4 w-px shrink-0 bg-[color-mix(in_srgb,var(--color-on-surface-variant)_34%,transparent)]"
    />
  )
}

/**
 * 渲染设置入口的滑杆图标。
 *
 * @returns 滑杆 SVG 图标。
 */
function SlidersIcon() {
  return (
    <svg
      aria-hidden="true"
      className="shrink-0"
      fill="none"
      height="18"
      viewBox="0 0 24 24"
      width="18"
      xmlns="http://www.w3.org/2000/svg"
    >
      <title>视频生成设置</title>
      <path d="M4 7h7" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
      <path d="M15 7h5" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
      <path d="M4 17h4" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
      <path d="M12 17h8" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
      <circle cx="13" cy="7" r="2" stroke="currentColor" strokeWidth="2" />
      <circle cx="10" cy="17" r="2" stroke="currentColor" strokeWidth="2" />
    </svg>
  )
}

/**
 * 渲染下拉箭头图标。
 *
 * @returns 下拉 SVG 图标。
 */
function ChevronDownIcon() {
  return (
    <svg
      aria-hidden="true"
      className="shrink-0 text-on-surface-variant"
      fill="none"
      height="16"
      viewBox="0 0 16 16"
      width="16"
      xmlns="http://www.w3.org/2000/svg"
    >
      <title>展开</title>
      <path
        d="m4 6 4 4 4-4"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2.2"
      />
    </svg>
  )
}
