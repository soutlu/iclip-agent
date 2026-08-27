import type { ReactNode } from 'react'
import {
  createVideoBatchKey,
  formatVideoBatchSecond,
  formatVideoBatchShotLabel,
} from '@/features/artifacts/renderers/video-batch-prompt.utils'
import type { VideoPromptBatch } from '@/features/artifacts/types/video-prompt.types'

interface VideoBatchPromptListProps {
  batches: VideoPromptBatch[]
  renderPromptAction?: (batch: VideoPromptBatch) => ReactNode
  renderPromptContent?: (batch: VideoPromptBatch) => ReactNode
}

export default function VideoBatchPromptList({
  batches,
  renderPromptAction,
  renderPromptContent,
}: VideoBatchPromptListProps) {
  return (
    <div className="grid gap-4">
      {batches.map((batch) => {
        const batchKey = createVideoBatchKey(batch)
        const second = formatVideoBatchSecond(batch.second)
        const shotLabel = formatVideoBatchShotLabel(batch)
        const promptAction = renderPromptAction?.(batch)
        const promptContent = renderPromptContent?.(batch)

        return (
          <section
            key={batchKey}
            className="rounded-xl border border-border bg-[color-mix(in_srgb,var(--color-on-surface)_2%,transparent)] p-5 shadow-[var(--shadow-1)]"
          >
            <div className="space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1.5">
                  <p className="text-caption font-medium tracking-[0.16em] text-canvas-label-text uppercase">
                    镜头 {String(batch.index).padStart(2, '0')}
                  </p>
                  <h4 className="text-canvas-label leading-tight font-medium">
                    {shotLabel ?? `视频镜头 ${String(batch.index).padStart(2, '0')}`}
                  </h4>
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  {second ? (
                    <span className="rounded-full border border-border bg-[color-mix(in_srgb,var(--color-on-surface)_6%,transparent)] px-3 py-1 text-label text-canvas-card-text/72">
                      时长 · {second}
                    </span>
                  ) : null}
                  {promptAction ? (
                    <div className="flex items-center gap-2">{promptAction}</div>
                  ) : null}
                </div>
              </div>

              <div className="rounded-lg border border-[color-mix(in_srgb,var(--color-on-surface)_10%,transparent)] bg-canvas-card-bg px-4 py-4 text-body leading-relaxed text-canvas-card-text/86">
                {promptContent ?? <p className="break-words whitespace-pre-wrap">{batch.prompt}</p>}
              </div>

              {batch.referenceImages && batch.referenceImages.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {batch.referenceImages.map((imageKey) => (
                    <span
                      key={`${batchKey}:${imageKey}`}
                      className="rounded-full border border-border bg-[color-mix(in_srgb,var(--color-on-surface)_6%,transparent)] px-3 py-1 text-label text-canvas-card-text/72"
                    >
                      参考图 · {imageKey}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          </section>
        )
      })}
    </div>
  )
}
