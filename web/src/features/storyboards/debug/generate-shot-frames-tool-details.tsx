import type { ToolCallMessagePart } from '@assistant-ui/react'
import { z } from 'zod'
import { DebugImagePreviewRail, type DebugImagePreview } from './debug-tool-result-images'

/** 逐帧生成的返回契约：一次调用一批，未完成的批只带 status 与 error。 */
const shotFramesResultSchema = z.object({
  error: z.string().nullish(),
  frames: z.array(
    z.object({
      no: z.string().trim().min(1),
      shot: z.number(),
      url: z.string().trim().min(1),
    }),
  ),
  message: z.string(),
  status: z.string(),
})

/** 按设计稿将镜头帧结果投影为等高、自然比例的单排图片轨道。 */
export default function GenerateShotFramesToolDetails({
  toolCall,
}: {
  toolCall: ToolCallMessagePart
}) {
  const parsedResult = shotFramesResultSchema.safeParse(toolCall.result)
  const result = parsedResult.success ? parsedResult.data : null
  const frames = result?.frames ?? []
  const shotCount = new Set(frames.map((frame) => frame.shot)).size
  const framePreviews = frames.map<DebugImagePreview>((frame, index) => {
    const orderLabel = String(index + 1).padStart(2, '0')
    const frameLabel = `镜头帧 ${frame.no}`
    return {
      altText: frameLabel,
      attachmentId: frame.no,
      badge: orderLabel,
      fileName: frameLabel,
      mediaType: 'image',
      url: frame.url,
    }
  })
  const unfinished = result && result.status !== 'done' ? (result.error ?? result.message) : null

  return (
    <section
      aria-label={`${toolCall.toolName} 调用详情`}
      className="rounded-md bg-[var(--color-surface-container-low)] p-3"
      role="region"
    >
      <p className="font-mono text-caption font-semibold text-[var(--color-on-surface)]">
        {toolCall.toolName}
      </p>

      <details className="group mt-3">
        <summary className="flex cursor-pointer list-none items-center justify-between border-b border-[var(--color-outline-variant)] pb-2 text-label text-[var(--color-on-surface-variant)] [&::-webkit-details-marker]:hidden">
          <span>输入</span>
          <span className="transition-transform duration-200 group-open:rotate-180">⌄</span>
        </summary>
        <pre
          aria-label={`${toolCall.toolName} 输入`}
          className="thin-scrollbar overflow-x-auto pt-2 font-mono text-caption break-words whitespace-pre-wrap text-[var(--color-on-surface)]"
          tabIndex={0}
        >
          {toolCall.argsText || JSON.stringify(toolCall.args, null, 2)}
        </pre>
      </details>

      <div className="pt-3">
        {toolCall.result === undefined ? (
          <p className="text-body-sm text-[var(--color-on-surface-variant)]" role="status">
            等待工具返回
          </p>
        ) : !result ? (
          <p className="text-body-sm text-[var(--color-error)]" role="alert">
            generate_shot_frames 结果格式无效，无法预览图片。
          </p>
        ) : (
          <>
            <div className="mb-3 flex flex-wrap items-baseline gap-x-8 gap-y-1">
              <p className="text-body-sm font-semibold text-[var(--color-on-surface)]">
                {frames.length} 张镜头帧 · {shotCount} 个镜头
              </p>
              <p className="text-label text-[var(--color-on-surface-variant)]">
                左右滑动浏览 · 双击查看大图
              </p>
            </div>

            {unfinished ? (
              <p className="mb-3 text-body-sm text-[var(--color-error)]" role="alert">
                {unfinished}
              </p>
            ) : null}

            {frames.length > 0 ? (
              <DebugImagePreviewRail
                activation="double-click"
                ariaLabel="视频帧预览"
                images={framePreviews}
              />
            ) : unfinished ? null : (
              <p className="text-body-sm text-[var(--color-on-surface-variant)]">暂无可预览图片</p>
            )}
          </>
        )}
      </div>
    </section>
  )
}
