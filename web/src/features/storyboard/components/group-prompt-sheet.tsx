/** 整组原文直接展示与复制，不经镜头解析，保留前言、空白和帧引用编号。 */

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { Button } from '@/shared/ui/button'
import { DialogBody, DialogHeader, DialogRoot, DialogSurface } from '@/shared/ui/dialog'
import { toast } from '@/shared/ui/toast'
import { aspectRatioStyle, type Shot } from '../shots'

type GroupPromptSheetProps = {
  shot: Shot
  aspectRatio: string
  onClose: () => void
  onGenerate: () => void
  generateDisabled: boolean
  submitting: boolean
  generateNote?: string | undefined
  triggerRef?: RefObject<HTMLButtonElement | null> | undefined
}

export function GroupPromptSheet({
  aspectRatio,
  generateDisabled,
  generateNote,
  submitting,
  onClose,
  onGenerate,
  shot,
  triggerRef,
}: GroupPromptSheetProps) {
  const sheetRef = useRef<HTMLElement | null>(null)
  const readingRef = useRef<HTMLDivElement | null>(null)
  const returnFocusRef = useRef<Element | null>(null)
  const previewTriggerRef = useRef<HTMLButtonElement | null>(null)
  const [preview, setPreview] = useState<{ number: number; url: string } | null>(null)
  // 帧编号本身是 prompt 的引用身份，同一地址可以对应多个编号。
  const references = shot.imageUrls.map((url, index) => ({ number: index + 1, url }))

  const closeSheet = useCallback(() => {
    const trigger = returnFocusRef.current
    onClose()
    // 仅显式收起归还焦点；切换到其它面板时保留用户新选的控件。
    requestAnimationFrame(() => {
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus()
    })
  }, [onClose])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== 'Escape' ||
        event.defaultPrevented ||
        preview !== null ||
        !sheetRef.current?.contains(document.activeElement)
      ) {
        return
      }
      event.preventDefault()
      closeSheet()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [closeSheet, preview])

  useEffect(() => {
    returnFocusRef.current = triggerRef?.current ?? document.activeElement
    readingRef.current?.focus()
  }, [triggerRef])

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(shot.prompt)
      toast('已复制完整提示词')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '复制失败')
    }
  }

  return (
    <aside
      aria-label="镜头组完整提示词"
      className="group-prompt-sheet absolute inset-0 flex min-h-0 min-w-0 animate-in flex-col overflow-hidden rounded-t-lg border-[0.5px] border-chat-hairline bg-background shadow-[var(--shadow-2)] duration-(--dur-m) ease-(--ease-decel) slide-in-from-bottom motion-reduce:animate-none"
      ref={sheetRef}
    >
      <header className="relative flex shrink-0 items-center justify-between gap-3 border-b-[0.5px] border-chat-hairline px-5 pt-7 pb-4">
        <span
          aria-hidden="true"
          className="absolute top-2 left-1/2 h-1 w-9 -translate-x-1/2 rounded-full bg-outline-variant"
        />
        <div className="min-w-0">
          <h3 className="text-body font-medium text-on-surface">
            镜头组 {shot.index} · 完整提示词
          </h3>
          <p className="mt-1 text-body-sm text-on-surface-faint">
            {shot.seconds} 秒 · {aspectRatio} · {shot.imageUrls.length} 张参考图
          </p>
        </div>
        <Button
          aria-label="收起完整提示词"
          className="shrink-0"
          onClick={closeSheet}
          size="md"
          trailingIcon="expand"
          variant="ghost"
        >
          收起
        </Button>
      </header>

      <div className="group-prompt-body min-h-0 flex-1">
        <div
          aria-label="镜头组原文"
          className="group-prompt-reading min-h-0 min-w-0 overflow-y-auto overscroll-contain p-5 ui-focus-inline"
          ref={readingRef}
          role="region"
          tabIndex={-1}
        >
          <p className="text-body leading-relaxed wrap-anywhere whitespace-pre-wrap text-on-surface">
            {shot.prompt}
          </p>
        </div>
        <section
          aria-label="本组参考图"
          className="group-prompt-references min-h-0 min-w-0 overflow-y-auto overscroll-contain border-l-[0.5px] border-chat-hairline p-4"
        >
          <h4 className="mb-3 text-body-sm font-medium text-on-surface-variant">
            参考图 · {shot.imageUrls.length} 张
          </h4>
          {shot.imageUrls.length === 0 ? (
            <p className="text-body-sm text-on-surface-faint">本组暂无参考图</p>
          ) : (
            <div className="grid grid-cols-2 items-start gap-x-3 gap-y-4">
              {references.map(({ number, url }) => (
                <figure className="min-w-0" key={number}>
                  <button
                    aria-label={`查看参考图 @Image${number}`}
                    className="block w-full cursor-zoom-in overflow-hidden rounded-xs bg-surface-container ui-focus"
                    onClick={(event) => {
                      previewTriggerRef.current = event.currentTarget
                      setPreview({ number, url })
                    }}
                    type="button"
                  >
                    <img
                      alt={`镜头组 ${shot.index} 参考图 @Image${number}`}
                      className="block w-full object-contain"
                      loading="lazy"
                      src={url}
                      style={{ aspectRatio: aspectRatioStyle(aspectRatio) }}
                    />
                  </button>
                  <figcaption className="mt-1 text-caption text-on-surface-variant">
                    @Image{number}
                  </figcaption>
                </figure>
              ))}
            </div>
          )}
        </section>
      </div>

      <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t-[0.5px] border-chat-hairline px-5 py-3">
        {generateNote === undefined ? null : (
          <p className="w-full text-body-sm text-on-surface-faint">{generateNote}</p>
        )}
        <Button onClick={() => void copyPrompt()} size="md" variant="ghost">
          复制完整提示词
        </Button>
        <Button disabled={generateDisabled} leadingIcon="video" onClick={onGenerate} size="md">
          {submitting ? '提交中…' : '生成视频'}
        </Button>
      </footer>

      <DialogRoot onOpenChange={(open) => !open && setPreview(null)} open={preview !== null}>
        <DialogSurface
          aria-describedby={undefined}
          className="max-w-3xl"
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            previewTriggerRef.current?.focus()
          }}
          onEscapeKeyDown={(event) => event.stopPropagation()}
        >
          <DialogHeader closeLabel="关闭参考图" title={`参考图 @Image${preview?.number ?? ''}`} />
          <DialogBody>
            {preview === null ? null : (
              <img
                alt={`镜头组 ${shot.index} 参考图 @Image${preview.number}`}
                className="mx-auto max-h-[60vh] max-w-full object-contain"
                src={preview.url}
              />
            )}
          </DialogBody>
        </DialogSurface>
      </DialogRoot>
    </aside>
  )
}
