import { useState } from 'react'
import { Button } from '@/shared/ui/button'
import { DialogBody, DialogFooter } from '@/shared/ui/dialog'
import { Textarea } from '@/shared/ui/field'
import { MediaLightbox, type LightboxMedia } from '@/shared/ui/media-lightbox'
import type { TaskCreationDraft } from '../task-creation'
import { TaskVideoPreview } from './task-media-field'

type TaskCreationPreviewProps = {
  draft: TaskCreationDraft
  error: string | null
  blockedReason: string | null
  sending: boolean
  onBack: () => void
  onConfirm: () => void
}

/** 显示将被提交的原始消息和媒体；返回修改不会触发保存或运行。 */
export function TaskCreationPreview({
  draft,
  error,
  blockedReason,
  sending,
  onBack,
  onConfirm,
}: TaskCreationPreviewProps) {
  const failure = blockedReason ?? error
  const [preview, setPreview] = useState<LightboxMedia | null>(null)
  const text = draft.content.find((part) => part.type === 'text')?.text ?? ''
  const images = draft.content.filter((part) => part.type === 'image')
  const video = draft.content.find((part) => part.type === 'video')

  return (
    <>
      <DialogBody className="flex flex-col gap-5 px-6 pt-2 pb-6">
        <p className="text-body-sm text-on-surface-variant">来自「{draft.title}」</p>
        <Textarea
          aria-label="发送文字预览"
          className="task-creation-text resize-none rounded-sm border-border ui-focus-inline"
          readOnly
          rows={13}
          value={text}
        />
        {images.length > 0 && (
          <section aria-label="参考图片" className="flex flex-col gap-3">
            <h3 className="text-body-sm font-semibold text-on-surface">
              参考图片（{images.length}）
            </h3>
            <div className="task-creation-images">
              {images.map((part, index) => (
                <button
                  key={part.source.url}
                  aria-label={`预览图片 ${index + 1}`}
                  className="aspect-square cursor-zoom-in overflow-hidden rounded-sm border border-border bg-surface-container-low ui-focus"
                  onClick={() =>
                    setPreview({ kind: 'image', url: part.source.url, name: `图片 ${index + 1}` })
                  }
                  type="button"
                >
                  <img
                    alt={`图片 ${index + 1}`}
                    className="size-full object-contain"
                    src={part.source.url}
                  />
                </button>
              ))}
            </div>
          </section>
        )}
        {video && (
          <section aria-label="参考视频" className="flex flex-col gap-3">
            <h3 className="text-body-sm font-semibold text-on-surface">参考视频</h3>
            <TaskVideoPreview
              url={video.source.url}
              name="参考视频"
              onOpen={() => setPreview({ kind: 'video', url: video.source.url, name: '参考视频' })}
            />
          </section>
        )}
        {failure && (
          <p className="text-body-sm text-error" role="alert">
            {failure}
          </p>
        )}
      </DialogBody>
      <DialogFooter>
        <Button disabled={sending} onClick={onBack} variant="outlined">
          返回修改
        </Button>
        <span className="text-caption text-on-surface-variant max-sm:hidden">将创建新的对话</span>
        <Button disabled={Boolean(blockedReason)} loading={sending} onClick={onConfirm}>
          确认并开始
        </Button>
      </DialogFooter>
      <MediaLightbox media={preview} onClose={() => setPreview(null)} />
    </>
  )
}
