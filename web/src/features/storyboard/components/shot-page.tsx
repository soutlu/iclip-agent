/**
 * 一个镜头组一页：一张大卡（左画面 60% / 右描述 40%），卡外两侧圆形箭头切帧，卡下一行是本组
 * 每个镜头的第一张帧。
 *
 * 组之间是上下翻页，不在这里管——本组件只认「当前是哪一帧」，翻组由外面的 scroll-snap 容器做。
 */

import { useState } from 'react'
import { cn } from '@/shared/lib/utils'
import type { TranscriptAttachment } from '@/shared/transcript/vendor'
import { IconButton } from '@/shared/ui/button'
import { MediaLightbox } from '@/shared/ui/media-lightbox'
import { tagVariants } from '@/shared/ui/tag'
import {
  aspectRatioStyle,
  firstFrameOfScene,
  sceneOfFrame,
  shotName,
  splitPrompt,
  splitShotTimeline,
  type PromptSegment,
  type Shot,
} from '../shots'

type ShotPageProps = {
  shot: Shot
  aspectRatio: string
  /** 当前看的是第几张帧（`@ImageN` 的 N）。 */
  frameNumber: number
  onPickFrame: (frame: number) => void
}

/**
 * 渲染一个镜头组。
 *
 * @param props - 组件属性。
 * @param props.shot - 这一组。
 * @param props.aspectRatio - 画幅，如 `9:16`。
 * @param props.frameNumber - 当前帧。
 * @param props.onPickFrame - 换一帧。
 * @returns 一页。
 */
export function ShotPage({ aspectRatio, frameNumber, onPickFrame, shot }: ShotPageProps) {
  const [zoomed, setZoomed] = useState<TranscriptAttachment | null>(null)
  const timeline = splitShotTimeline(shot)
  const frames = shot.imageUrls
  const currentUrl = frames[frameNumber - 1]
  const currentScene = sceneOfFrame(timeline, frameNumber)

  return (
    <section
      aria-label={`镜头组 ${shot.index}`}
      className="flex h-full w-full shrink-0 snap-start flex-col gap-3 p-4"
    >
      <div className="flex min-h-0 flex-1 items-stretch gap-2">
        <IconButton
          className="shrink-0 self-center rounded-full border-[0.5px] border-chat-hairline bg-chat-card-bg"
          disabled={frameNumber <= 1}
          label="上一帧"
          name="back"
          onClick={() => onPickFrame(frameNumber - 1)}
          size="lg"
        />

        {/* 卡撑满可用高度：画面按高度缩放，描述列跟着一起长，不留上下大片空白 */}
        <article className="grid min-h-0 flex-1 grid-cols-[3fr_2fr] overflow-hidden rounded-lg border-[0.5px] border-chat-hairline bg-chat-card-bg">
          <div className="relative flex min-h-0 flex-col items-center justify-center gap-2 bg-surface-container p-3">
            {currentUrl === undefined ? (
              <p className="text-body-sm text-on-surface-faint">这一组没有帧</p>
            ) : (
              <>
                <img
                  alt={`镜头组 ${shot.index} 第 ${frameNumber} 帧`}
                  className="min-h-0 max-w-full flex-1 object-contain"
                  src={currentUrl}
                  style={{ aspectRatio: aspectRatioStyle(aspectRatio) }}
                />
                <p className="shrink-0 text-label text-on-surface-variant">
                  @{frameNumber}
                  {currentScene === undefined ? '' : ` · 镜头 ${currentScene.scene}`}
                </p>
                <IconButton
                  className="absolute top-3 right-3 bg-chat-card-bg"
                  label="打开原图"
                  name="zoom"
                  onClick={() =>
                    setZoomed({
                      attachmentId: `frame-${shot.index}-${frameNumber}`,
                      mediaType: 'image/*',
                      name: `镜头组 ${shot.index} 第 ${frameNumber} 帧`,
                      source: { kind: 'url', url: currentUrl },
                    })
                  }
                  size="sm"
                />
              </>
            )}
          </div>

          <div className="flex min-h-0 flex-col gap-3 p-5">
            <h3 className="flex min-w-0 items-center gap-2.5 text-title font-semibold text-on-surface">
              <ShotBadge index={shot.index} />
              <span className="min-w-0 truncate" title={shotName(shot)}>
                {shotName(shot)}
              </span>
            </h3>
            <p className="text-label text-on-surface-faint">分镜描述</p>

            <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
              {timeline.preamble === '' ? null : (
                <details className="shrink-0 rounded-sm bg-surface-container-low px-3 py-2">
                  <summary className="cursor-pointer text-label text-on-surface-variant">
                    参考锁定与剪辑形式
                  </summary>
                  <p className="pt-2 text-body-sm whitespace-pre-wrap text-on-surface-variant">
                    {timeline.preamble}
                  </p>
                </details>
              )}

              {timeline.scenes.length === 0 ? (
                // 这一组没写时间线（旧交付或模型没照格式写）：整段当一段描述画，不假装有镜头。
                <p className="rounded-md bg-surface-container-low p-3 text-body leading-loose whitespace-pre-wrap text-on-surface">
                  <PromptText
                    highlighted={frameNumber}
                    onPickFrame={onPickFrame}
                    segments={splitPrompt(shot.prompt)}
                  />
                </p>
              ) : (
                timeline.scenes.map((scene) => (
                  <div
                    className={cn(
                      'shrink-0 rounded-md p-3 ui-motion-s',
                      // 选中态走中性的 state-active（与侧栏行、筛选 chip 同一口径），不用主色铺底
                      scene.id === currentScene?.id
                        ? 'bg-state-active'
                        : 'bg-surface-container-low',
                    )}
                    key={scene.id}
                  >
                    <p className="pb-1 text-label text-on-surface-faint">
                      镜头 {scene.scene} · {scene.startSeconds}–{scene.endSeconds} 秒
                    </p>
                    <p className="text-body leading-loose whitespace-pre-wrap text-on-surface">
                      <PromptText
                        highlighted={frameNumber}
                        onPickFrame={onPickFrame}
                        segments={scene.segments}
                      />
                    </p>
                  </div>
                ))
              )}
            </div>
          </div>
        </article>

        <IconButton
          className="shrink-0 self-center rounded-full border-[0.5px] border-chat-hairline bg-chat-card-bg"
          disabled={frameNumber >= frames.length}
          label="下一帧"
          name="next"
          onClick={() => onPickFrame(frameNumber + 1)}
          size="lg"
        />
      </div>

      {timeline.scenes.length === 0 ? null : (
        <div aria-label="本组镜头" className="flex shrink-0 gap-2 overflow-x-auto px-11 pb-1">
          {timeline.scenes.map((scene) => {
            const first = firstFrameOfScene(scene)
            const url = first === undefined ? undefined : frames[first - 1]
            return (
              <button
                aria-current={scene.id === currentScene?.id}
                className={cn(
                  'relative flex h-16 w-24 shrink-0 items-center justify-center overflow-hidden rounded-sm border-[0.5px] border-chat-hairline bg-surface-container ui-focus',
                  first === undefined ? 'cursor-not-allowed' : 'cursor-pointer',
                  scene.id === currentScene?.id && 'outline-2 -outline-offset-2 outline-primary',
                )}
                disabled={first === undefined}
                key={scene.id}
                onClick={() => first !== undefined && onPickFrame(first)}
                type="button"
              >
                {url === undefined ? (
                  <span className="text-caption text-on-surface-faint">无帧</span>
                ) : (
                  <img alt="" className="size-full object-cover" src={url} />
                )}
                <span
                  className={cn(
                    tagVariants({ variant: 'soft' }),
                    'absolute top-1 left-1 bg-chat-card-bg',
                  )}
                >
                  镜头 {scene.scene}
                </span>
                <span className="absolute right-1 bottom-1 rounded-xs bg-chat-card-bg px-1 text-caption text-on-surface-variant">
                  {Math.round((scene.endSeconds - scene.startSeconds) * 10) / 10}s
                </span>
              </button>
            )
          })}
        </div>
      )}

      <MediaLightbox attachment={zoomed} onClose={() => setZoomed(null)} />
    </section>
  )
}

type PromptTextProps = {
  segments: readonly PromptSegment[]
  /** 当前帧：对应的芯片画成选中态。 */
  highlighted: number
  onPickFrame: (frame: number) => void
}

/**
 * 一段描述：正文照原样，`@ImageN` 画成可点的芯片。
 *
 * @param props - 组件属性。
 * @param props.segments - 切好的段。
 * @param props.highlighted - 当前帧。
 * @param props.onPickFrame - 点芯片换帧。
 * @returns 描述正文。
 */
function PromptText({ highlighted, onPickFrame, segments }: PromptTextProps) {
  return segments.map((segment) =>
    segment.kind === 'text' ? (
      <span key={segment.id}>{segment.text}</span>
    ) : (
      <button
        aria-label={`看第 ${segment.number} 帧`}
        className={cn(
          tagVariants({ variant: 'soft' }),
          'mx-0.5 cursor-pointer align-middle ui-focus',
          segment.number === highlighted && 'bg-on-surface text-surface',
        )}
        key={segment.id}
        onClick={() => onPickFrame(segment.number)}
        type="button"
      >
        @{segment.number}
      </button>
    ),
  )
}

type ShotBadgeProps = { index: number }

/**
 * 序号方块。
 *
 * @param props - 组件属性。
 * @param props.index - 第几组。
 * @returns 序号方块。
 */
function ShotBadge({ index }: ShotBadgeProps) {
  return (
    <span className="inline-grid size-5.5 shrink-0 place-items-center rounded-xs bg-secondary-container text-label font-semibold text-on-secondary-container">
      {index}
    </span>
  )
}
