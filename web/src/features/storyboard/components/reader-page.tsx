/** 一组分镜的内容选择、预览与编辑；全局设定和时间线共用图片操作。 */
import { useEffect, useEffectEvent, useRef, useState, type CSSProperties } from 'react'
import { Icon } from '@/shared/icons'
import { copyText } from '@/shared/lib/clipboard'
import { cn } from '@/shared/lib/utils'
import { IconButton } from '@/shared/ui/button'
import type { LightboxMedia } from '@/shared/ui/media-lightbox'
import { toast } from '@/shared/ui/toast'
import type { FrameBadge } from '../frame-status'
import { type Shot } from '../shot-document'
import {
  shotContents,
  updateContentPrompt,
  insertContentReference,
  appendContentImage,
} from '../shot-content'
import { aspectRatioStyle, MAX_REFERENCE_IMAGES } from '../shots'
import { uploadFrameImage } from '../storyboard.api'
import { FrameAssignmentPicker } from './frame-assignment-picker'
import { FramePreview } from './frame-preview'
import { PromptEditor, type PromptEditorHandle } from './prompt-editor'
import { ShotFilmstrip } from './shot-filmstrip'

type ReaderPageProps = {
  shot: Shot
  aspect_ratio: string
  content: string | undefined
  frame: number | undefined
  /** 本组每帧最新图片任务的角标，由工作台按对话级列表算好给下来。 */
  frameBadges: ReadonlyMap<number, FrameBadge>
  editingDisabled: boolean
  onUpdateShot: (updater: (current: Shot) => Shot) => Shot | undefined
  onReplaceFrame: (frame: number, previousUrl: string, url: string) => void
  onUploaded: (frame: number, url: string) => void
  onUploadingChange: (group: number, uploading: boolean) => void
  onSelect: (content: string, frame?: number) => void
  onOpenPrompt: (trigger: HTMLElement) => void
  onPreview: (media: LightboxMedia, trigger: HTMLElement) => void
  onEditFrame: (frame: number, sourceUrl: string) => void
}

export function ReaderPage({
  aspect_ratio,
  content: requestedContent,
  editingDisabled,
  frame,
  frameBadges,
  onEditFrame,
  onOpenPrompt,
  onSelect,
  onPreview,
  onReplaceFrame,
  onUpdateShot,
  onUploaded,
  onUploadingChange,
  shot,
}: ReaderPageProps) {
  const contents = shotContents(shot)
  const content = contents.find((item) => item.id === requestedContent) ?? contents[0]
  const frameNumber =
    frame !== undefined && content.frameNumbers.includes(frame) ? frame : content.frameNumbers[0]
  const url = frameNumber === undefined ? undefined : shot.image_urls[frameNumber - 1]
  const currentFrameIndex = content.frameNumbers.indexOf(frameNumber ?? -1)
  const [width = 0, height = 0] = aspect_ratio.split(':').map(Number)
  const editorRef = useRef<PromptEditorHandle | null>(null)
  const uploadRevisionRef = useRef(0)
  const targetKey = JSON.stringify([shot.index, content.id])
  const [pickerTarget, setPickerTarget] = useState<string | null>(null)
  const [uploadTarget, setUploadTarget] = useState<string | null>(null)
  // 操作只属于发起它的内容；外部切换目标时立即恢复新目标的可操作状态。
  const pickerOpen = pickerTarget === targetKey
  const uploading = uploadTarget === targetKey
  const [replacing, setReplacing] = useState(false)
  const reportUploading = useEffectEvent((busy: boolean) => onUploadingChange(shot.index, busy))
  useEffect(() => {
    reportUploading(uploading || replacing)
    return () => reportUploading(false)
  }, [uploading, replacing])
  useEffect(() => {
    return () => {
      uploadRevisionRef.current += 1
      setUploadTarget(null)
      setPickerTarget(null)
    }
  }, [targetKey])

  const select = (id: string, number?: number) => {
    uploadRevisionRef.current += 1
    setUploadTarget(null)
    setPickerTarget(null)
    onSelect(id, number)
  }
  const selectImage = (number: number) => {
    // 编辑器中的新引用可尚未进入派生列表，下一次渲染会从正文重新计算。
    if (number >= 1 && number <= shot.image_urls.length) select(content.id, number)
  }
  const changePrompt = (text: string) =>
    onUpdateShot((current) => updateContentPrompt(current, content.id, text))

  const updateTarget = (updater: (current: Shot) => Shot): Shot => {
    const updated = onUpdateShot((current) => {
      const target = shotContents(current).find((item) => item.id === content.id)
      if (target?.prompt === undefined) throw new Error('所选内容已不存在，请重新选择')
      if (content.timelineIndex !== undefined) {
        const before = shot.prompt.timeline[content.timelineIndex]?.timestamps
        const after = current.prompt.timeline[content.timelineIndex]?.timestamps
        if (before?.[0] !== after?.[0] || before?.[1] !== after?.[1])
          throw new Error('这个镜头已发生变化，请重新选择')
      }
      return updater(current)
    })
    if (updated === undefined) throw new Error('镜头组已不存在，请重新选择')
    return updated
  }
  const pickExisting = (number: number, previousUrl: string) => {
    if (editingDisabled) return
    try {
      const insertion = editorRef.current?.getInsertion()
      updateTarget((current) => {
        if (current.image_urls[number - 1] !== previousUrl)
          throw new Error('这张图片已发生变化，请重新选择')
        return insertContentReference(current, content.id, number, insertion)
      })
      select(content.id, number)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '关联图片失败')
    }
  }
  const upload = async (file: File) => {
    if (editingDisabled || uploading) return
    const revision = ++uploadRevisionRef.current
    setUploadTarget(targetKey)
    setPickerTarget(null)
    try {
      const newUrl = await uploadFrameImage(file)
      if (revision !== uploadRevisionRef.current) return
      const insertion = editorRef.current?.getInsertion()
      const updated = updateTarget((current) =>
        appendContentImage(current, content.id, newUrl, insertion),
      )
      onUploaded(updated.image_urls.length, newUrl)
      select(content.id, updated.image_urls.length)
    } catch (error) {
      if (revision === uploadRevisionRef.current)
        toast.error(error instanceof Error ? error.message : '上传失败')
    } finally {
      if (revision === uploadRevisionRef.current) setUploadTarget(null)
    }
  }
  const sharing =
    frameNumber === undefined
      ? []
      : contents.filter((item) => item.frameNumbers.includes(frameNumber))
  const sharedCaption =
    sharing.length > 1
      ? `@Image${frameNumber} · ${sharing.map((item) => (item.timelineIndex === undefined ? item.title : `镜头 ${item.timelineIndex + 1}`)).join('、')} 共用`
      : undefined
  const editorLabel =
    content.timelineIndex === undefined ? content.title : `镜头 ${content.timelineIndex + 1} 的描述`

  return (
    <section
      aria-label={`镜头组 ${shot.index}`}
      className="storyboard-page flex h-full min-h-0 w-full min-w-0 shrink-0 snap-start flex-col gap-4 p-4"
    >
      <div className="storyboard-stage">
        <IconButton
          className="storyboard-page-arrow rounded-full border-[0.5px] border-chat-hairline bg-chat-card-bg"
          disabled={currentFrameIndex <= 0}
          label="上一帧"
          name="back"
          size="md"
          onClick={() => {
            const n = content.frameNumbers[currentFrameIndex - 1]
            if (n !== undefined) selectImage(n)
          }}
        />
        <article
          className={cn(
            'storyboard-preview overflow-hidden rounded-xs border-[0.5px] border-chat-hairline bg-chat-card-bg',
            url === undefined
              ? 'storyboard-preview-text'
              : width > height && 'storyboard-preview-wide',
          )}
          style={
            {
              '--storyboard-frame-aspect': aspectRatioStyle(aspect_ratio),
              '--storyboard-frame-tall': width > 0 && height > 0 ? height / width : 1,
            } as CSSProperties
          }
        >
          {url === undefined || frameNumber === undefined ? null : (
            <FramePreview
              badge={frameBadges.get(frameNumber)}
              disabled={editingDisabled}
              aspectRatio={aspect_ratio}
              caption={sharedCaption}
              key={`${content.id}:${frameNumber}:${url}`}
              name={`镜头组 ${shot.index} 第 ${frameNumber} 帧`}
              url={url}
              onEdit={() => onEditFrame(frameNumber, url)}
              onOpen={() =>
                onPreview(
                  { kind: 'image', name: `镜头组 ${shot.index} 第 ${frameNumber} 帧`, url },
                  window.document.activeElement instanceof HTMLElement
                    ? window.document.activeElement
                    : window.document.body,
                )
              }
              onReplace={(newUrl) => onReplaceFrame(frameNumber, url, newUrl)}
              onUpload={uploadFrameImage}
              onUploadingChange={setReplacing}
            />
          )}
          <div className="storyboard-description flex min-h-0 min-w-0 flex-col gap-4 p-4">
            <div className="flex min-w-0 items-center gap-2">
              <h3 className="flex min-w-0 flex-1 items-center gap-2 text-body font-medium text-on-surface">
                {content.timelineIndex === undefined ? null : (
                  <span className="inline-grid size-5.5 shrink-0 place-items-center rounded-xs bg-surface-container-high text-label font-medium text-on-surface">
                    {content.timelineIndex + 1}
                  </span>
                )}
                <span className="min-w-0 truncate" title={content.title}>
                  {content.title}
                </span>
              </h3>
              {content.prompt === undefined ? null : (
                <IconButton
                  label={content.kind === 'global' ? '复制全局设定' : '复制镜头正文'}
                  name="copy"
                  size="sm"
                  onClick={() =>
                    void copyText(content.prompt ?? '')
                      .then(() => toast('已复制'))
                      .catch(() => toast.error('复制失败'))
                  }
                />
              )}
            </div>
            {content.prompt === undefined ? (
              <p className="text-body text-on-surface-faint">这张图片尚未被全局设定或镜头引用</p>
            ) : (
              <div className="min-h-0 flex-1 overflow-y-auto">
                <PromptEditor
                  readOnly={editingDisabled}
                  aria-label={editorLabel}
                  frames={shot.image_urls}
                  highlighted={frameNumber}
                  key={content.id}
                  onChange={changePrompt}
                  onPickFrame={selectImage}
                  ref={editorRef}
                  value={content.prompt}
                />
              </div>
            )}
          </div>
        </article>
        <IconButton
          className="storyboard-page-arrow rounded-full border-[0.5px] border-chat-hairline bg-chat-card-bg"
          disabled={currentFrameIndex < 0 || currentFrameIndex >= content.frameNumbers.length - 1}
          label="下一帧"
          name="next"
          size="md"
          onClick={() => {
            const n = content.frameNumbers[currentFrameIndex + 1]
            if (n !== undefined) selectImage(n)
          }}
        />
      </div>
      <div className="storyboard-filmstrip flex shrink-0 items-stretch gap-1 border-t-[0.5px] border-chat-hairline pt-3">
        <ShotFilmstrip
          activeContent={content.id}
          badges={frameBadges}
          frameNumber={frameNumber}
          frames={shot.image_urls}
          onSelect={select}
          contents={contents}
        />
        <button
          aria-label="添加图片"
          title="添加图片"
          type="button"
          className="storyboard-add-frame grid shrink-0 cursor-pointer place-items-center rounded-xs border-[0.5px] border-chat-hairline bg-surface-container text-on-surface-faint ui-focus disabled:cursor-default disabled:opacity-50"
          disabled={editingDisabled || content.prompt === undefined || uploading}
          onClick={() => setPickerTarget(targetKey)}
        >
          <Icon decorative name="add" size="md" />
        </button>
        <button
          aria-label="完整提示词"
          title="完整提示词"
          type="button"
          className="storyboard-open-prompt grid shrink-0 cursor-pointer place-items-center rounded-xs border-[0.5px] border-chat-hairline bg-surface-container text-on-surface-variant ui-focus"
          onClick={(event) => onOpenPrompt(event.currentTarget)}
        >
          <Icon decorative name="collapse" size="md" />
        </button>
        {uploading ? (
          <span className="self-center text-body-sm text-on-surface-faint" role="status">
            正在上传新图…
          </span>
        ) : null}
      </div>
      <FrameAssignmentPicker
        disabled={editingDisabled}
        frames={shot.image_urls}
        onClose={() => setPickerTarget(null)}
        onPickExisting={pickExisting}
        onUpload={upload}
        open={pickerOpen}
        canUpload={shot.image_urls.length < MAX_REFERENCE_IMAGES}
      />
    </section>
  )
}
