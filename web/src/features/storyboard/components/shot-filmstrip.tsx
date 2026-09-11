/** 镜头首帧保持固定身份，选中的镜头在原位展开其余帧。 */

import { useEffect, useRef, type CSSProperties } from 'react'
import { cn } from '@/shared/lib/utils'

import type { ShotContent } from '../shot-content'
import { Icon } from '@/shared/icons'

type ShotFilmstripProps = {
  contents: readonly ShotContent[]
  activeContent: string
  frameNumber: number | undefined
  frames: readonly string[]
  onSelect: (content: string, frame?: number) => void
}

export function ShotFilmstrip({
  activeContent,
  frameNumber,
  frames,
  onSelect,
  contents,
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
  }, [activeContent, frameNumber])

  return (
    <nav aria-label="本组镜头" className="storyboard-strip" ref={stripRef}>
      {contents.map((scene) => {
        const active = scene.id === activeContent
        const first = scene.frameNumbers[0]
        const visibleFrames = active ? scene.frameNumbers : scene.frameNumbers.slice(0, 1)
        return (
          <div
            aria-current={active}
            aria-label={
              scene.timelineIndex === undefined ? scene.title : `镜头 ${scene.timelineIndex + 1}`
            }
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
                  aria-label={
                    scene.timelineIndex === undefined
                      ? scene.title
                      : `镜头 ${scene.timelineIndex + 1}`
                  }
                  className="storyboard-thumbnail grid cursor-pointer place-items-center bg-surface-container text-caption text-on-surface-faint ui-focus"
                  aria-pressed={active}
                  onClick={() => onSelect(scene.id)}
                  type="button"
                >
                  {scene.kind === 'global' ? <Icon decorative name="file" size="md" /> : '无帧'}
                </button>
              ) : (
                visibleFrames.map((number) => (
                  <button
                    aria-label={
                      active
                        ? `预览第 ${number} 帧`
                        : scene.timelineIndex === undefined
                          ? scene.title
                          : `镜头 ${scene.timelineIndex + 1}`
                    }
                    aria-pressed={active ? number === frameNumber : undefined}
                    className="storyboard-thumbnail relative cursor-pointer overflow-hidden bg-surface-container ui-focus"
                    key={number}
                    onClick={() => onSelect(scene.id, number)}
                    type="button"
                  >
                    <img
                      alt={number === first ? `${scene.title} 首图` : `第 ${number} 帧`}
                      className="size-full object-cover"
                      src={frames[number - 1]}
                    />
                    {scene.frameNumbers.length > 1 ? (
                      <span className="storyboard-frame-label">@{number}</span>
                    ) : null}
                  </button>
                ))
              )}
              {scene.seconds === undefined ? null : (
                <span className="storyboard-scene-duration">
                  {Math.round(scene.seconds * 10) / 10}s
                </span>
              )}
            </div>
            <div className="storyboard-scene-caption" title={scene.title}>
              {scene.timelineIndex === undefined ? null : (
                <span className="storyboard-scene-number">{scene.timelineIndex + 1}</span>
              )}
              <span className="storyboard-scene-title min-w-0 truncate">{scene.title}</span>
              {scene.frameNumbers.length > 1 ? (
                <span className="ml-auto shrink-0">{scene.frameNumbers.length} 张</span>
              ) : null}
            </div>
          </div>
        )
      })}
    </nav>
  )
}
