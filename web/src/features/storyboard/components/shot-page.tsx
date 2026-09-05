/** 草稿与生成资格由父组件管理；本组件仅处理当前镜头组和帧，组间翻页由外层容器负责。 */

import { useId, useRef, useState } from 'react'
import { cn } from '@/shared/lib/utils'
import { Button, IconButton } from '@/shared/ui/button'
import { Input } from '@/shared/ui/field'
import { type LightboxMedia, MediaLightbox } from '@/shared/ui/media-lightbox'
import { toast } from '@/shared/ui/toast'
import { tagVariants } from '@/shared/ui/tag'
import {
  applyFrameOp,
  parsePromptDoc,
  type PromptLine,
  SECONDS_MAX,
  SECONDS_MIN,
  serializePromptDoc,
} from '../prompt-doc'
import { aspectRatioStyle, parseSceneHeader, shotName, type Shot } from '../shots'
import type { FrameCandidate } from '../storyboard.api'
import { FramePicker, type FramePickerMode } from './frame-picker'
import { PromptEditor } from './prompt-editor'

type ShotPageProps = {
  shot: Shot
  aspectRatio: string
  frameNumber: number
  onPickFrame: (frame: number) => void
  onChangeShot: (next: Shot) => void
  candidates: readonly FrameCandidate[]
  onUploadFrame: (file: File) => Promise<string>
  onGenerateVideo: () => void
  generateDisabled: boolean
  generating: boolean
  /** 生成不可用的原因，如画幅不支持或草稿未保存。 */
  generateNote?: string | undefined
}

const sceneOf = (header: string | null, lines: readonly PromptLine[]) => {
  const parsedHeader = header === null ? undefined : parseSceneHeader(header)
  const frames = [
    ...new Set(
      lines.flatMap((line) =>
        line.flatMap((inline) => (inline.kind === 'frame' ? [inline.n] : [])),
      ),
    ),
  ]
  return { frames, header: parsedHeader }
}

export function ShotPage({
  aspectRatio,
  candidates,
  frameNumber,
  generateDisabled,
  generateNote,
  generating,
  onChangeShot,
  onGenerateVideo,
  onPickFrame,
  onUploadFrame,
  shot,
}: ShotPageProps) {
  const [zoomed, setZoomed] = useState<LightboxMedia | null>(null)
  const [picker, setPicker] = useState<FramePickerMode | null>(null)
  const uploadRef = useRef<HTMLInputElement | null>(null)
  const secondsId = useId()
  const doc = parsePromptDoc(shot.prompt)
  const frames = shot.imageUrls
  const currentUrl = frames[frameNumber - 1]
  const sections = doc.sections.map((section, index) => ({
    ...sceneOf(section.header, section.lines),
    index,
    section,
  }))
  const scenes = sections.filter((item) => item.header !== undefined)
  const currentSection =
    sections.find((item) => item.header !== undefined && item.frames.includes(frameNumber)) ??
    sections.at(-1)

  const changePrompt = (sectionIndex: number, lines: PromptLine[]) => {
    const next = {
      sections: doc.sections.map((section, index) =>
        index === sectionIndex ? { header: section.header, lines } : section,
      ),
    }
    onChangeShot({ ...shot, prompt: serializePromptDoc(next) })
  }

  const changeSeconds = (raw: string) => {
    const seconds = Number(raw)
    if (!Number.isInteger(seconds)) return
    onChangeShot({ ...shot, seconds })
  }

  const replaceOrInsert = (url: string) => {
    if (picker === 'replace') {
      onChangeShot(applyFrameOp(shot, { n: frameNumber, type: 'replace', url }))
    } else {
      const sectionIndex = currentSection?.index ?? doc.sections.length - 1
      onChangeShot(applyFrameOp(shot, { after: frameNumber, sectionIndex, type: 'insert', url }))
      onPickFrame(frameNumber + 1)
    }
    setPicker(null)
  }

  const removeFrame = () => {
    onChangeShot(applyFrameOp(shot, { n: frameNumber, type: 'remove' }))
    onPickFrame(Math.max(1, Math.min(frameNumber, frames.length - 1)))
  }

  const moveFrame = (to: number) => {
    onChangeShot(applyFrameOp(shot, { n: frameNumber, to, type: 'move' }))
    onPickFrame(to)
  }

  const upload = async (file: File) => {
    try {
      const url = await onUploadFrame(file)
      replaceOrInsert(url)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '上传失败')
    }
  }

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
                  {currentSection?.header === undefined
                    ? ''
                    : ` · 镜头 ${currentSection.header.scene}`}
                </p>
                <IconButton
                  className="absolute top-3 right-3 bg-chat-card-bg"
                  label="打开原图"
                  name="zoom"
                  onClick={() =>
                    setZoomed({
                      kind: 'image',
                      name: `镜头组 ${shot.index} 第 ${frameNumber} 帧`,
                      url: currentUrl,
                    })
                  }
                  size="sm"
                />
              </>
            )}

            <div
              aria-label="帧操作"
              className="flex shrink-0 items-center gap-1 rounded-full border-[0.5px] border-chat-hairline bg-chat-card-bg px-1.5 py-0.5"
              role="toolbar"
            >
              <IconButton
                disabled={currentUrl === undefined}
                label="替换这一帧"
                name="image"
                onClick={() => setPicker('replace')}
                size="sm"
              />
              <IconButton
                label="上传一张图当帧"
                name="add-file"
                onClick={() => uploadRef.current?.click()}
                size="sm"
              />
              <IconButton label="加一帧" name="add" onClick={() => setPicker('insert')} size="sm" />
              <IconButton
                disabled={frameNumber <= 1}
                label="左移这一帧"
                name="back"
                onClick={() => moveFrame(frameNumber - 1)}
                size="sm"
              />
              <IconButton
                disabled={frameNumber >= frames.length}
                label="右移这一帧"
                name="next"
                onClick={() => moveFrame(frameNumber + 1)}
                size="sm"
              />
              <IconButton
                disabled={currentUrl === undefined}
                label="删掉这一帧"
                name="delete"
                onClick={removeFrame}
                size="sm"
              />
              <input
                accept="image/*"
                aria-label="选择要上传的图片"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  event.target.value = ''
                  if (file !== undefined) {
                    setPicker(currentUrl === undefined ? 'insert' : 'replace')
                    void upload(file)
                  }
                }}
                ref={uploadRef}
                type="file"
              />
            </div>
          </div>

          <div className="flex min-h-0 flex-col gap-3 p-5">
            <h3 className="flex min-w-0 items-center gap-2.5 text-title font-semibold text-on-surface">
              <ShotBadge index={shot.index} />
              <span className="min-w-0 truncate" title={shotName(shot)}>
                {shotName(shot)}
              </span>
            </h3>
            <p className="flex items-center gap-2 text-body-sm text-on-surface-faint">
              <span className="flex items-center gap-1.5">
                <label htmlFor={secondsId}>时长</label>
                <Input
                  aria-label={`镜头组 ${shot.index} 的时长（秒）`}
                  className="h-(--control-height-md) w-16 text-center"
                  id={secondsId}
                  max={SECONDS_MAX}
                  min={SECONDS_MIN}
                  onChange={(event) => changeSeconds(event.target.value)}
                  step={1}
                  type="number"
                  value={shot.seconds}
                />
                秒
              </span>
              <span>· {frames.length} 帧</span>
            </p>
            <p className="text-label text-on-surface-faint">分镜描述</p>

            <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
              {sections.map(({ header, index, section }) => {
                if (index === 0) {
                  if (section.lines.every((line) => line.length === 0)) return null
                  return (
                    <details
                      className="shrink-0 rounded-sm bg-surface-container-low px-3 py-2"
                      key="preamble"
                    >
                      <summary className="cursor-pointer text-label text-on-surface-variant">
                        参考锁定与剪辑形式
                      </summary>
                      <PromptEditor
                        aria-label={`镜头组 ${shot.index} 的前言`}
                        className="pt-2 text-body-sm"
                        frames={frames}
                        highlighted={frameNumber}
                        lines={section.lines}
                        onChange={(lines) => changePrompt(index, lines)}
                        onPickFrame={onPickFrame}
                      />
                    </details>
                  )
                }
                const current = currentSection?.index === index
                return (
                  <div
                    className={cn(
                      'shrink-0 rounded-md p-3 ui-motion-s',
                      current ? 'bg-state-active' : 'bg-surface-container-low',
                    )}
                    key={`${index}-${section.header ?? ''}`}
                  >
                    {header === undefined ? null : (
                      <p className="pb-1 text-label text-on-surface-faint">
                        镜头 {header.scene} · {header.startSeconds}–{header.endSeconds} 秒
                      </p>
                    )}
                    <PromptEditor
                      aria-label={
                        header === undefined
                          ? `镜头组 ${shot.index} 的描述`
                          : `镜头 ${header.scene} 的描述`
                      }
                      className="leading-loose"
                      frames={frames}
                      highlighted={frameNumber}
                      lines={section.lines}
                      onChange={(lines) => changePrompt(index, lines)}
                      onPickFrame={onPickFrame}
                    />
                  </div>
                )
              })}
            </div>

            <div className="flex shrink-0 flex-col gap-1">
              <Button
                className="w-full"
                disabled={generateDisabled}
                leadingIcon="video"
                onClick={onGenerateVideo}
                size="lg"
              >
                {generating ? '正在出片…' : '生成视频'}
              </Button>
              {generateNote === undefined ? null : (
                <p className="text-body-sm text-on-surface-faint">{generateNote}</p>
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

      {scenes.length === 0 ? null : (
        <div aria-label="本组镜头" className="flex shrink-0 gap-2 overflow-x-auto px-11 pb-1">
          {scenes.map((scene) => {
            const first = scene.frames[0]
            const url = first === undefined ? undefined : frames[first - 1]
            const active = currentSection?.index === scene.index
            return (
              <button
                aria-current={active}
                className={cn(
                  'relative flex h-16 w-24 shrink-0 items-center justify-center overflow-hidden rounded-sm border-[0.5px] border-chat-hairline bg-surface-container ui-focus',
                  first === undefined ? 'cursor-not-allowed' : 'cursor-pointer',
                  active && 'outline-2 -outline-offset-2 outline-primary',
                )}
                disabled={first === undefined}
                key={scene.index}
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
                  镜头 {scene.header?.scene}
                </span>
                {scene.header === undefined ? null : (
                  <span className="absolute right-1 bottom-1 rounded-xs bg-chat-card-bg px-1 text-caption text-on-surface-variant">
                    {Math.round((scene.header.endSeconds - scene.header.startSeconds) * 10) / 10}s
                  </span>
                )}
              </button>
            )
          })}
        </div>
      )}

      <FramePicker
        candidates={candidates}
        inUse={frames}
        mode={picker}
        onClose={() => setPicker(null)}
        onPick={replaceOrInsert}
        onUpload={upload}
      />
      <MediaLightbox media={zoomed} onClose={() => setZoomed(null)} />
    </section>
  )
}

type ShotBadgeProps = { index: number }

function ShotBadge({ index }: ShotBadgeProps) {
  return (
    <span className="inline-grid size-5.5 shrink-0 place-items-center rounded-xs bg-secondary-container text-label font-semibold text-on-secondary-container">
      {index}
    </span>
  )
}
