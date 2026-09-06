/** 草稿与生成资格由父组件管理；本组件仅处理当前镜头组和帧，组间翻页由外层容器负责。 */

import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { Button, IconButton } from '@/shared/ui/button'
import { type LightboxMedia, MediaLightbox } from '@/shared/ui/media-lightbox'
import { toast } from '@/shared/ui/toast'
import {
  insertShotFrame,
  parsePromptDoc,
  type PromptLine,
  serializeLines,
  serializePromptDoc,
} from '../prompt-doc'
import { aspectRatioStyle, parseSceneHeader, shotName, type Shot } from '../shots'
import type { FrameCandidate } from '../storyboard.api'
import { FramePicker } from './frame-picker'
import { PromptEditor } from './prompt-editor'
import { ShotFilmstrip } from './shot-filmstrip'

type ShotPageProps = {
  shot: Shot
  aspectRatio: string
  frameNumber: number
  onPickFrame: (frame: number) => void
  onChangeShot: (next: Shot) => void
  candidates: readonly FrameCandidate[]
  onUploadFrame: (file: File) => Promise<string>
  onGenerateVideo: () => void
  onOpenAllShots: () => void
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
  onOpenAllShots,
  onPickFrame,
  onUploadFrame,
  shot,
}: ShotPageProps) {
  const [zoomed, setZoomed] = useState<LightboxMedia | null>(null)
  const [pickerMode, setPickerMode] = useState<'insert' | 'replace' | null>(null)
  const uploadRevisionRef = useRef(0)
  const [sceneSelection, setSceneSelection] = useState<{
    index: number
    frame: number
    empty: boolean
  } | null>(null)
  const doc = parsePromptDoc(shot.prompt)
  const frames = shot.imageUrls
  useEffect(
    () => () => {
      uploadRevisionRef.current += 1
    },
    [frameNumber, shot.index],
  )
  const sections = doc.sections.map((section, index) => ({
    ...sceneOf(section.header, section.lines),
    index,
    section,
  }))
  const scenes = sections.filter((item) => item.header !== undefined)
  // 横版帧在左右分栏里只能缩成一条，改成上下堆叠让画面吃满卡片宽度。
  const [ratioWidth = 0, ratioHeight = 0] = aspectRatio.split(':').map(Number)
  const wideFrame = ratioWidth > ratioHeight
  // 画幅高宽比驱动卡片高度；画幅读不出时按正方处理，卡片仍有确定高度。
  const frameTall = ratioWidth > 0 && ratioHeight > 0 ? ratioHeight / ratioWidth : 1
  const groupSeconds = Math.round(shot.seconds * 10) / 10
  const groupSummary =
    scenes.length === 0 ? `整组 ${groupSeconds}s` : `整组 ${scenes.length} 镜头 · ${groupSeconds}s`
  // 显式选择区分共用首帧的镜头；外部帧导航优先，编辑时不按引用重新切镜。
  const explicitScene =
    sceneSelection?.frame === frameNumber
      ? scenes.find((item) => item.index === sceneSelection.index)
      : undefined
  const currentSection =
    explicitScene ??
    scenes.find((item) => item.frames.includes(frameNumber)) ??
    (frames.length === 0 ? scenes[0] : undefined) ??
    (scenes.length === 0 ? sections[0] : undefined)
  const currentUrl =
    explicitScene !== undefined && sceneSelection?.empty ? undefined : frames[frameNumber - 1]
  const currentTitle =
    currentSection === undefined
      ? '未关联镜头'
      : shotName({ ...shot, prompt: serializeLines(currentSection.section.lines) })

  const pickFrame = (number: number) => {
    setSceneSelection(null)
    onPickFrame(number)
  }

  const pickScene = (index: number, number?: number) => {
    setSceneSelection({ index, frame: number ?? frameNumber, empty: number === undefined })
    if (number !== undefined) onPickFrame(number)
  }

  const changePrompt = (sectionIndex: number, lines: PromptLine[]) => {
    setSceneSelection({ index: sectionIndex, frame: frameNumber, empty: currentUrl === undefined })
    const next = {
      sections: doc.sections.map((section, index) =>
        index === sectionIndex ? { ...section, lines } : section,
      ),
    }
    onChangeShot({ ...shot, prompt: serializePromptDoc(next) })
  }

  const closePicker = () => {
    uploadRevisionRef.current += 1
    setPickerMode(null)
  }

  const selectFrame = (url: string) => {
    if (pickerMode === 'replace') {
      onChangeShot({
        ...shot,
        imageUrls: frames.map((frame, index) => (index === frameNumber - 1 ? url : frame)),
      })
    } else {
      const sectionIndex = currentSection?.index ?? doc.sections.length - 1
      const after = frames.length === 0 ? 0 : frameNumber
      onChangeShot(insertShotFrame(shot, { after, sectionIndex, url }))
      pickFrame(after + 1)
    }
    closePicker()
  }

  const upload = async (file: File) => {
    const revision = ++uploadRevisionRef.current
    try {
      const url = await onUploadFrame(file)
      // 关闭弹窗、另选候选图或开始新上传后，不再应用旧上传的结果。
      if (revision !== uploadRevisionRef.current) return
      selectFrame(url)
    } catch (error) {
      if (revision !== uploadRevisionRef.current) return
      toast.error(error instanceof Error ? error.message : '上传失败')
    }
  }

  return (
    <section
      aria-label={`镜头组 ${shot.index}`}
      className="storyboard-page flex h-full min-h-0 w-full min-w-0 shrink-0 snap-start flex-col gap-4 p-4"
    >
      <div className="storyboard-stage">
        <IconButton
          className="storyboard-page-arrow rounded-full border-[0.5px] border-chat-hairline bg-chat-card-bg"
          disabled={frameNumber <= 1}
          label="上一帧"
          name="back"
          onClick={() => pickFrame(frameNumber - 1)}
          size="md"
        />
        <article
          className={cn(
            'storyboard-preview overflow-hidden rounded-xs border-[0.5px] border-chat-hairline bg-chat-card-bg',
            wideFrame && 'storyboard-preview-wide',
          )}
          style={
            {
              '--storyboard-frame-aspect': aspectRatioStyle(aspectRatio),
              '--storyboard-frame-tall': frameTall,
            } as CSSProperties
          }
        >
          <div className="storyboard-media relative min-h-0 min-w-0 bg-surface-container">
            {currentUrl === undefined ? (
              <p className="text-body-sm text-on-surface-faint">这个镜头还没有帧</p>
            ) : (
              <button
                aria-label="打开原图"
                className="absolute inset-0 cursor-zoom-in ui-focus"
                onClick={() =>
                  setZoomed({
                    kind: 'image',
                    name: `镜头组 ${shot.index} 第 ${frameNumber} 帧`,
                    url: currentUrl,
                  })
                }
                type="button"
              >
                <img
                  alt={`镜头组 ${shot.index} 第 ${frameNumber} 帧`}
                  className="size-full object-contain"
                  src={currentUrl}
                  style={{ aspectRatio: aspectRatioStyle(aspectRatio) }}
                />
              </button>
            )}
            {currentUrl === undefined ? null : (
              <Button
                className="absolute right-2 bottom-2 rounded-xs"
                leadingIcon="image"
                onClick={() => setPickerMode('replace')}
                size="md"
                variant="inverted"
              >
                替换图片
              </Button>
            )}
          </div>

          <div className="storyboard-description flex min-h-0 min-w-0 flex-col gap-4 p-4">
            <h3 className="flex min-w-0 items-center gap-2 text-body font-medium text-on-surface">
              {currentSection?.header === undefined ? null : (
                <ShotBadge index={currentSection.header.scene} />
              )}
              <span className="min-w-0 truncate" title={currentTitle}>
                {currentTitle}
              </span>
            </h3>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {currentSection === undefined ? (
                <p className="text-body text-on-surface-faint">这张帧还没有关联的镜头描述</p>
              ) : (
                <PromptEditor
                  aria-label={
                    currentSection.header === undefined
                      ? `镜头组 ${shot.index} 的描述`
                      : `镜头 ${currentSection.header.scene} 的描述`
                  }
                  frames={frames}
                  highlighted={frameNumber}
                  key={currentSection.index}
                  lines={currentSection.section.lines}
                  onChange={(lines) => changePrompt(currentSection.index, lines)}
                  onPickFrame={(number) => pickScene(currentSection.index, number)}
                />
              )}
            </div>
          </div>
        </article>
        <IconButton
          className="storyboard-page-arrow rounded-full border-[0.5px] border-chat-hairline bg-chat-card-bg"
          disabled={frameNumber >= frames.length}
          label="下一帧"
          name="next"
          onClick={() => pickFrame(frameNumber + 1)}
          size="md"
        />
      </div>

      <div className="storyboard-filmstrip flex shrink-0 items-stretch gap-1 border-t-[0.5px] border-chat-hairline pt-3">
        <ShotFilmstrip
          activeScene={currentSection?.index}
          frameNumber={frameNumber}
          frames={frames}
          onPickFrame={pickFrame}
          onPickScene={pickScene}
          scenes={scenes.map((scene) => ({
            frameNumbers: scene.frames,
            id: scene.index,
            number: scene.header?.scene ?? scene.index,
            seconds:
              scene.header === undefined ? 0 : scene.header.endSeconds - scene.header.startSeconds,
            title: shotName({ ...shot, prompt: serializeLines(scene.section.lines) }),
          }))}
        />
        <button
          aria-label="加一帧"
          className="storyboard-add-frame grid shrink-0 ui-state cursor-pointer place-items-center rounded-xs border-[0.5px] border-chat-hairline bg-surface-container text-on-surface-faint ui-focus"
          onClick={() => setPickerMode('insert')}
          title="加一帧"
          type="button"
        >
          <Icon decorative name="add" size="lg" />
        </button>
        <button
          aria-label="全部分镜"
          className="storyboard-all-shots grid shrink-0 ui-state cursor-pointer place-items-center rounded-xs border-[0.5px] border-chat-hairline bg-surface-container text-on-surface-variant ui-focus"
          onClick={onOpenAllShots}
          title="全部分镜"
          type="button"
        >
          <Icon decorative name="collapse" size="md" />
        </button>
        {/* 出片提交的是整组，按钮跟着代表整组的胶片条走，不放在只显示单个镜头的描述栏。 */}
        <div className="storyboard-group-actions">
          <span className="text-right text-body-sm text-on-surface-faint">
            {generateNote ?? groupSummary}
          </span>
          <Button
            className="rounded-xs"
            disabled={generateDisabled}
            leadingIcon="video"
            onClick={onGenerateVideo}
            size="md"
          >
            {generating ? '正在出片…' : '生成视频'}
          </Button>
        </div>
      </div>
      <FramePicker
        candidates={candidates}
        inUse={frames}
        onClose={closePicker}
        onPick={selectFrame}
        onUpload={upload}
        open={pickerMode !== null}
        title={pickerMode === 'replace' ? '替换图片' : '加一帧'}
      />
      <MediaLightbox media={zoomed} onClose={() => setZoomed(null)} />
    </section>
  )
}

type ShotBadgeProps = { index: number }

function ShotBadge({ index }: ShotBadgeProps) {
  return (
    <span className="inline-grid size-5.5 shrink-0 place-items-center rounded-xs bg-surface-container-high text-label font-medium text-on-surface">
      {index}
    </span>
  )
}
