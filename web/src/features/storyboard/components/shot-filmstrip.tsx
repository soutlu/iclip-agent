/** 镜头首帧保持固定身份，选中的镜头在原位展开其余帧。 */

import { useEffect, useRef, type CSSProperties } from 'react'
import { cn } from '@/shared/lib/utils'

type Scene = {
  id: number
  number: number
  title: string
  seconds: number
  frameNumbers: readonly number[]
}

type ShotFilmstripProps = {
  scenes: readonly Scene[]
  activeScene: number | undefined
  frameNumber: number
  frames: readonly string[]
  onPickFrame: (number: number) => void
  onPickScene: (index: number, frame?: number) => void
}

export function ShotFilmstrip({
  activeScene,
  frameNumber,
  frames,
  onPickFrame,
  onPickScene,
  scenes,
}: ShotFilmstripProps) {
  const stripRef = useRef<HTMLElement | null>(null)
  // 只滚动胶片条，避免 scrollIntoView 带动外层镜头组翻页。
  useEffect(() => {
    const strip = stripRef.current
    const selected = strip?.querySelector<HTMLElement>('[aria-pressed="true"]')
    if (strip === null || selected === undefined || selected === null) return
    const revealFrame = () => {
      const stripBounds = strip.getBoundingClientRect()
      const selectedBounds = selected.getBoundingClientRect()
      if (selectedBounds.left < stripBounds.left)
        strip.scrollLeft -= stripBounds.left - selectedBounds.left
      else if (selectedBounds.right > stripBounds.right)
        strip.scrollLeft += selectedBounds.right - stripBounds.right
    }
    revealFrame()
    // 展开动画期间 scrollWidth 仍在变，结束后再校准，避免窄屏末帧被裁切。
    strip.addEventListener('transitionend', revealFrame)
    window.addEventListener('resize', revealFrame)
    return () => {
      strip.removeEventListener('transitionend', revealFrame)
      window.removeEventListener('resize', revealFrame)
    }
  }, [activeScene, frameNumber])

  const unassigned = frames.flatMap((_, index) =>
    scenes.some((scene) => scene.frameNumbers.includes(index + 1)) ? [] : [index + 1],
  )

  return (
    <nav
      aria-label={scenes.length === 0 ? '本组全部帧' : '本组镜头'}
      className="storyboard-strip"
      ref={stripRef}
    >
      {scenes.map((scene) => {
        const active = scene.id === activeScene
        const first = scene.frameNumbers[0]
        const visibleFrames = active ? scene.frameNumbers : scene.frameNumbers.slice(0, 1)
        return (
          <div
            aria-current={active}
            aria-label={`镜头 ${scene.number}`}
            className={cn(
              'storyboard-scene',
              active && 'storyboard-scene-active',
              !active && scene.frameNumbers.length > 1 && 'storyboard-scene-stack',
            )}
            key={scene.id}
            role="group"
            style={
              { '--storyboard-frame-count': Math.max(1, visibleFrames.length) } as CSSProperties
            }
          >
            <div className="storyboard-scene-frames">
              {visibleFrames.length === 0 ? (
                <button
                  aria-label={`镜头 ${scene.number}`}
                  className="storyboard-thumbnail grid cursor-pointer place-items-center bg-surface-container text-caption text-on-surface-faint ui-focus"
                  onClick={() => onPickScene(scene.id)}
                  type="button"
                >
                  无帧
                </button>
              ) : (
                visibleFrames.map((number) => (
                  <button
                    aria-label={active ? `预览第 ${number} 帧` : `镜头 ${scene.number}`}
                    aria-pressed={active ? number === frameNumber : undefined}
                    className="storyboard-thumbnail relative cursor-pointer overflow-hidden bg-surface-container ui-focus"
                    key={number}
                    onClick={() => onPickScene(scene.id, number)}
                    type="button"
                  >
                    <img
                      alt={number === first ? `镜头 ${scene.number} 首帧` : `第 ${number} 帧`}
                      className="size-full object-cover"
                      src={frames[number - 1]}
                    />
                    {active && scene.frameNumbers.length > 1 ? (
                      <span className="storyboard-frame-label">@{number}</span>
                    ) : null}
                  </button>
                ))
              )}
              <span className="storyboard-scene-duration">
                {Math.round(scene.seconds * 10) / 10}s
              </span>
            </div>
            <div className="storyboard-scene-caption" title={scene.title}>
              <span className="storyboard-scene-number">{scene.number}</span>
              <span className="min-w-0 flex-1 truncate">{scene.title}</span>
              {active && scene.frameNumbers.length > 1 ? (
                <span className="shrink-0">{scene.frameNumbers.length} 帧</span>
              ) : null}
            </div>
          </div>
        )
      })}
      {unassigned.map((number) => (
        <button
          aria-label={`预览第 ${number} 帧`}
          aria-pressed={number === frameNumber}
          className="storyboard-scene cursor-pointer overflow-hidden text-left ui-focus"
          key={`unassigned-${number}`}
          onClick={() => onPickFrame(number)}
          type="button"
        >
          <img
            alt={`第 ${number} 帧`}
            className="storyboard-thumbnail object-cover"
            src={frames[number - 1]}
          />
          <span className="storyboard-scene-caption">
            @{number}
            {scenes.length > 0 ? ' · 未关联镜头' : ''}
          </span>
        </button>
      ))}
    </nav>
  )
}
