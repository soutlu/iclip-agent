import { useRef } from 'react'
import { Button } from '@/shared/ui/button'
import { DialogBody, DialogHeader, DialogRoot, DialogSurface } from '@/shared/ui/dialog'
import { FRAME_IMAGE_ACCEPT, type FrameCandidate } from '../storyboard.api'

type FrameAssignmentPickerProps = {
  open: boolean
  frames: readonly string[]
  candidates: readonly FrameCandidate[]
  error?: string | undefined
  onPickExisting: (number: number, url: string) => void
  onPickNew: (url: string) => void
  onUpload: (file: File) => Promise<void>
  onClose: () => void
}

export function FrameAssignmentPicker({
  candidates,
  error,
  frames,
  onClose,
  onPickExisting,
  onPickNew,
  onUpload,
  open,
}: FrameAssignmentPickerProps) {
  const uploadRef = useRef<HTMLInputElement | null>(null)
  const available = candidates.filter((candidate) => !frames.includes(candidate.url))
  const references = frames.map((url, index) => ({ url, number: index + 1 }))

  return (
    <DialogRoot onOpenChange={(next) => !next && onClose()} open={open}>
      <DialogSurface aria-label="添加图片">
        <DialogHeader
          actions={
            <>
              <Button
                leadingIcon="add-file"
                onClick={() => uploadRef.current?.click()}
                size="md"
                variant="tonal"
              >
                上传图片
              </Button>
              <input
                accept={FRAME_IMAGE_ACCEPT}
                aria-label="选择要上传的图片"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  event.target.value = ''
                  if (file !== undefined) void onUpload(file)
                }}
                ref={uploadRef}
                type="file"
              />
            </>
          }
          closeLabel="关闭添加图片"
          title="添加图片"
        >
          选择本组图片插入引用，或添加对话图片、上传新图。
        </DialogHeader>
        <DialogBody className="space-y-5">
          {error === undefined ? null : (
            <p className="text-body-sm text-error" role="alert">
              {error}
            </p>
          )}
          {references.length === 0 ? (
            <p className="text-body-sm text-on-surface-faint">本组还没有图片。</p>
          ) : (
            <section aria-label="本组已有图片">
              <h3 className="mb-3 text-body-sm font-medium text-on-surface">本组图片</h3>
              <ul className="grid grid-cols-4 gap-2">
                {references.map(({ number, url }) => (
                  <li key={number}>
                    <button
                      aria-label={`关联第 ${number} 张图片`}
                      className="relative block aspect-[9/16] w-full cursor-pointer overflow-hidden rounded-sm border-[0.5px] border-chat-hairline bg-surface-container ui-focus"
                      onClick={() => onPickExisting(number, url)}
                      type="button"
                    >
                      <img
                        alt={`本组图片 @Image${number}`}
                        className="size-full object-cover"
                        src={url}
                      />
                      <span className="absolute bottom-1 left-1 rounded-xs bg-chat-card-bg px-1 text-caption text-on-surface-variant">
                        @Image{number}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {available.length === 0 ? null : (
            <section aria-label="对话图片">
              <h3 className="mb-3 text-body-sm font-medium text-on-surface">对话图片</h3>
              <ul className="grid grid-cols-4 gap-2">
                {available.map((candidate) => (
                  <li key={candidate.url}>
                    <button
                      aria-label={`添加 ${candidate.label}`}
                      className="relative block aspect-[9/16] w-full cursor-pointer overflow-hidden rounded-sm border-[0.5px] border-chat-hairline bg-surface-container ui-focus"
                      onClick={() => onPickNew(candidate.url)}
                      type="button"
                    >
                      <img
                        alt={candidate.label}
                        className="size-full object-cover"
                        src={candidate.url}
                      />
                      <span className="absolute bottom-1 left-1 rounded-xs bg-chat-card-bg px-1 text-caption text-on-surface-variant">
                        {candidate.label}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </DialogBody>
      </DialogSurface>
    </DialogRoot>
  )
}
