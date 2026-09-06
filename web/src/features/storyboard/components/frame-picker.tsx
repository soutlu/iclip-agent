import { useRef } from 'react'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { DialogBody, DialogHeader, DialogRoot, DialogSurface } from '@/shared/ui/dialog'
import { FRAME_IMAGE_ACCEPT, type FrameCandidate } from '../storyboard.api'

type FramePickerProps = {
  open: boolean
  candidates: readonly FrameCandidate[]
  /** 标记当前组已使用的帧，避免重复选择。 */
  inUse: readonly string[]
  onPick: (url: string) => void
  onUpload: (file: File) => Promise<void>
  onClose: () => void
}

export function FramePicker({
  candidates,
  inUse,
  onClose,
  onPick,
  onUpload,
  open,
}: FramePickerProps) {
  const uploadRef = useRef<HTMLInputElement | null>(null)

  return (
    <DialogRoot onOpenChange={(nextOpen) => !nextOpen && onClose()} open={open}>
      <DialogSurface aria-label="加一帧">
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
          closeLabel="关闭"
          title="加一帧"
        >
          从这段对话生成过的帧里选一张，或者上传一张。
        </DialogHeader>
        <DialogBody>
          {candidates.length === 0 ? (
            <p className="py-8 text-center text-body-sm text-on-surface-faint">
              这段对话还没有生成过帧，可以上传一张。
            </p>
          ) : (
            <ul className="grid grid-cols-4 gap-2">
              {candidates.map((candidate) => {
                const used = inUse.includes(candidate.url)
                return (
                  <li key={candidate.url}>
                    <button
                      aria-label={`选 ${candidate.label}${used ? '（已在用）' : ''}`}
                      className={cn(
                        'relative block aspect-[9/16] w-full cursor-pointer overflow-hidden rounded-sm border-[0.5px] border-chat-hairline bg-surface-container ui-focus',
                        used && 'outline-2 -outline-offset-2 outline-primary',
                      )}
                      onClick={() => onPick(candidate.url)}
                      type="button"
                    >
                      <img alt="" className="size-full object-cover" src={candidate.url} />
                      <span className="absolute bottom-1 left-1 rounded-xs bg-chat-card-bg px-1 text-caption text-on-surface-variant">
                        {candidate.label}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </DialogBody>
      </DialogSurface>
    </DialogRoot>
  )
}
