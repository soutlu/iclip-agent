/**
 * 挑一张帧：候选是这段对话里 agent 生成过的帧，也可以上传一张。替换与加一帧共用这个框，
 * 只是选完落到哪里不同。
 */

import { useRef } from 'react'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { DialogBody, DialogHeader, DialogRoot, DialogSurface } from '@/shared/ui/dialog'
import type { FrameCandidate } from '../storyboard.api'

export type FramePickerMode = 'replace' | 'insert'

type FramePickerProps = {
  /** null 表示没打开。 */
  mode: FramePickerMode | null
  candidates: readonly FrameCandidate[]
  /** 这一组已经用着的地址：标出来，避免同一张选两次。 */
  inUse: readonly string[]
  onPick: (url: string) => void
  onUpload: (file: File) => Promise<void>
  onClose: () => void
}

/**
 * 渲染挑帧框。
 *
 * @param props - 组件属性。
 * @returns 对话框。
 */
export function FramePicker({
  candidates,
  inUse,
  mode,
  onClose,
  onPick,
  onUpload,
}: FramePickerProps) {
  const uploadRef = useRef<HTMLInputElement | null>(null)
  const title = mode === 'insert' ? '加一帧' : '替换这一帧'

  return (
    <DialogRoot onOpenChange={(open) => !open && onClose()} open={mode !== null}>
      <DialogSurface aria-label={title}>
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
                accept="image/*"
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
          title={title}
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
