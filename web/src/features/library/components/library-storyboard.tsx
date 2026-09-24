/** 故事板：卡片右上角的「N 镜 · 时长」角标。能悬停的设备悬停或点它出浮层，触屏点它出底部面板；每镜一帧，保持原比例排成一条。 */

import { useEffect, useEffectEvent, useRef, useState, type KeyboardEvent } from 'react'
import { Icon } from '@/shared/icons'
import { videoSnapshotUrl } from '@/shared/lib/media-url'
import { cn } from '@/shared/lib/utils'
import { DialogBody, DialogHeader, DialogRoot, DialogSurface } from '@/shared/ui/dialog'
import { useHoverPreview } from '@/shared/ui/media-preview'
import { PopupAnchor, PopupRoot, PopupSurface, PopupTrigger } from '@/shared/ui/popup'
import type { LibraryVideo } from '../library.api'
import { snapshotWidthFor } from '../library-layout'
import {
  aspectOf,
  cutCountOf,
  formatClock,
  formatSecond,
  keyframesOf,
  type Keyframe,
} from '../library-media'

const canHover = () => window.matchMedia('(hover: hover)').matches

type StoryboardBadgeProps = {
  video: LibraryVideo
  seconds: number | null
  /** 窄列上只留镜数，不显示时长。 */
  compact: boolean
  /** 指着某一帧时给那一刻，卡片画面跳过去；故事板收起时给 null。 */
  onFocusFrame: (at: number | null) => void
  /** 点某一帧：进详情，从这一段开头播。 */
  onPickFrame: (at: number) => void
}

export function StoryboardBadge({
  video,
  seconds,
  compact,
  onFocusFrame,
  onPickFrame,
}: StoryboardBadgeProps) {
  const hover = useHoverPreview()
  // 点开的浮层不随指针离开收起，要点外面、再点角标或按 Esc。
  const [pinned, setPinned] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const frames = keyframesOf(video.take, seconds)
  const cuts = cutCountOf(video.take)
  if (frames.length === 0) return null

  const open = pinned || hover.open
  const close = () => {
    setPinned(false)
    hover.close()
  }
  const pick = (at: number) => {
    close()
    setSheetOpen(false)
    onPickFrame(at)
  }
  const hoverProps = {
    onPointerEnter: (event: React.PointerEvent) => {
      if (event.pointerType !== 'touch') hover.onEnter()
    },
    onPointerLeave: (event: React.PointerEvent) => {
      if (event.pointerType !== 'touch') hover.onLeave()
    },
  }
  const label = `故事板：${cuts === null ? `${frames.length} 段` : `${cuts} 镜`}${seconds === null ? '' : `，${formatClock(seconds)}`}`

  return (
    <>
      <PopupRoot
        onOpenChange={(next) => {
          if (next) setPinned(true)
          else close()
        }}
        open={open}
      >
        <PopupTrigger asChild>
          <button
            aria-label={label}
            className="library-card-badge library-storyboard-badge absolute top-2 right-2 cursor-pointer ui-focus"
            onClick={(event) => {
              // 触屏没有悬停，点角标出底部面板；拦下默认的开关，浮层不出。
              if (canHover()) return
              event.preventDefault()
              setSheetOpen(true)
            }}
            type="button"
            {...hoverProps}
          >
            <Icon decorative name="grid" size="xs" />
            {cuts === null ? null : `${cuts} 镜`}
            {cuts !== null && seconds !== null && !compact ? (
              <span aria-hidden className="library-card-badge-divider" />
            ) : null}
            {seconds === null || (compact && cuts !== null) ? null : formatClock(seconds)}
          </button>
        </PopupTrigger>
        {/* 浮层贴着整张画面放在旁边，不压住卡片本身；角标的父级就是画面。
            要排在触发按钮后面：Radix 按挂载顺序登记锚点，排在前面会被触发按钮顶掉。 */}
        <PopupAnchor className="pointer-events-none absolute inset-0" />
        {open ? (
          <PopupSurface
            align="start"
            aria-label="故事板"
            className="w-max max-w-[min(760px,calc(100vw-24px))] min-w-70 p-3.5 pb-3"
            collisionPadding={12}
            // 悬停出来的浮层不抢焦点，点开的才把焦点给第一帧。
            onOpenAutoFocus={(event) => {
              if (!pinned) event.preventDefault()
            }}
            side="right"
            sideOffset={12}
            {...hoverProps}
          >
            <StoryboardStrip
              frames={frames}
              heading
              onFocusFrame={onFocusFrame}
              onPick={pick}
              seconds={seconds}
              video={video}
            />
          </PopupSurface>
        ) : null}
      </PopupRoot>

      <DialogRoot onOpenChange={setSheetOpen} open={sheetOpen}>
        {sheetOpen ? (
          <DialogSurface aria-describedby={undefined}>
            <DialogHeader closeLabel="关闭故事板" title="故事板" />
            <DialogBody className="px-4 pt-3 pb-5">
              <StoryboardStrip
                frames={frames}
                heading={false}
                onFocusFrame={onFocusFrame}
                onPick={pick}
                seconds={seconds}
                video={video}
              />
            </DialogBody>
          </DialogSurface>
        ) : null}
      </DialogRoot>
    </>
  )
}

type StoryboardStripProps = {
  video: LibraryVideo
  frames: readonly Keyframe[]
  seconds: number | null
  /** 浮层自带标题行；底部面板的标题在面板表头里。 */
  heading: boolean
  onFocusFrame: (at: number | null) => void
  onPick: (at: number) => void
}

/** 帧条：挂上时对准第一帧，收起时告诉卡片不再对准；指针在条上时滚轮一律横向翻帧。 */
function StoryboardStrip({
  video,
  frames,
  seconds,
  heading,
  onFocusFrame,
  onPick,
}: StoryboardStripProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const stripRef = useRef<HTMLDivElement>(null)
  const [focused, setFocused] = useState(0)
  const { w, h } = aspectOf(video.take.aspectRatio)
  const frameHeight = w < h ? 132 : 96
  const snapshotWidth = snapshotWidthFor((frameHeight * w) / h, window.devicePixelRatio || 1)
  const scripted = video.take.script !== null
  const total = frames.at(-1)?.end ?? seconds ?? 0
  const current = frames[focused] ?? frames[0]

  const focusFrame = (order: number) => {
    const frame = frames[order]
    if (frame === undefined || order === focused) return
    setFocused(order)
    onFocusFrame(frame.at)
  }

  // 只在挂上与收起时各报一次，帧的切换由 focusFrame 自己报。
  const announce = useEffectEvent((mounted: boolean) =>
    onFocusFrame(mounted ? (frames[0]?.at ?? null) : null),
  )
  useEffect(() => {
    announce(true)
    return () => announce(false)
  }, [])

  // React 的 wheel 监听是被动的，拦不住页面滚动；在条的外框上挂一个非被动的原生监听。
  useEffect(() => {
    const root = rootRef.current
    const strip = stripRef.current
    if (root === null || strip === null) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? strip.clientWidth : 1
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
      strip.scrollLeft += delta * unit
    }
    root.addEventListener('wheel', onWheel, { passive: false })
    return () => root.removeEventListener('wheel', onWheel)
  }, [])

  // 左右方向键在帧之间移焦点。
  const onFrameKeyDown = (event: KeyboardEvent<HTMLButtonElement>, order: number) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    const buttons = stripRef.current?.querySelectorAll('button')
    const next = buttons?.item(order + (event.key === 'ArrowRight' ? 1 : -1))
    if (next === undefined || next === null) return
    event.preventDefault()
    next.focus()
  }

  return (
    <div className="library-storyboard" ref={rootRef}>
      <div className="mb-2.5 flex items-baseline justify-between gap-4">
        {heading ? <b className="text-body-sm font-semibold text-on-surface">故事板</b> : null}
        <span className="text-caption whitespace-nowrap text-on-surface-faint">
          {scripted ? `${frames.length} 镜` : `${frames.length} 段`} · {formatSecond(total)} 秒
          {scripted ? '' : ' · 均匀取帧'}
        </span>
      </div>
      <div aria-hidden className="mb-2.5 flex h-1 gap-0.5">
        {frames.map((frame, order) => (
          <span
            className={cn(
              'rounded-full ui-motion-s',
              order === focused ? 'bg-on-surface' : 'bg-surface-container-highest',
            )}
            key={frame.index}
            style={{ flex: `${frame.end - frame.start} 1 0` }}
          />
        ))}
      </div>
      <div className="library-storyboard-strip flex gap-1.5 overflow-x-auto pb-1" ref={stripRef}>
        {frames.map((frame, order) => {
          const src = videoSnapshotUrl(video.face.outputUrl, snapshotWidth, frame.at)
          return (
            <button
              aria-label={`${scripted ? '镜头' : '第'} ${frame.index}${scripted ? '' : ' 段'}，${formatSecond(frame.start)} 秒起，打开详情`}
              className="library-storyboard-frame shrink-0 cursor-pointer rounded-sm text-left ui-focus"
              data-current={order === focused || undefined}
              key={frame.index}
              onClick={() => onPick(frame.start)}
              onFocus={() => focusFrame(order)}
              onKeyDown={(event) => onFrameKeyDown(event, order)}
              onPointerEnter={() => focusFrame(order)}
              type="button"
            >
              <span
                className="library-storyboard-thumb relative block overflow-hidden rounded-sm bg-thumb-fallback"
                style={{ aspectRatio: `${w} / ${h}`, height: frameHeight }}
              >
                {src === undefined ? null : (
                  <img alt="" className="size-full object-contain" loading="lazy" src={src} />
                )}
                <span className="library-card-badge absolute top-1 left-1">{frame.index}</span>
              </span>
              <span className="mt-1 block font-mono text-caption text-on-surface-faint">
                {formatSecond(frame.start)}–{formatSecond(frame.end)}s
              </span>
            </button>
          )
        })}
      </div>
      {current === undefined ? null : (
        <p className="mt-2 line-clamp-2 min-h-11.5 border-t border-hairline pt-2.5 text-caption text-on-surface-variant">
          <b className="mr-1.5 font-semibold text-on-surface">
            {scripted ? `镜头 ${current.index}` : `第 ${current.index} 段`}
          </b>
          <span className="mr-1.5 font-mono text-on-surface-faint">
            {formatSecond(current.start)}–{formatSecond(current.end)}s
          </span>
          {current.prompt === null
            ? '这条片没有分镜脚本，按时长均匀取帧'
            : current.prompt.replace(/@Image\d+\s?/g, '')}
        </p>
      )}
    </div>
  )
}
