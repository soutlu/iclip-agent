import { cn } from '@/shared/lib/utils'
import {
  formatVideoPromptReadingSegments,
  VIDEO_PROMPT_REFERENCE_TAG_EXACT_PATTERN,
  VIDEO_PROMPT_REFERENCE_TAG_PATTERN,
} from './video-prompt-canvas-card.utils'

/**
 * 渲染提示词正文，并突出参考图标签。
 *
 * @param text - 待渲染的提示词片段。
 * @returns 可直接放入 React 文本节点的内容。
 */
const renderVideoPromptText = (text: string) =>
  text.split(VIDEO_PROMPT_REFERENCE_TAG_PATTERN).map((part, index) => {
    if (VIDEO_PROMPT_REFERENCE_TAG_EXACT_PATTERN.test(part)) {
      return (
        <span
          className="mx-0.5 inline-flex rounded-md bg-control-bg px-1.5 py-0.5 text-[0.88em] font-semibold text-chat-agent-rail ring-1 ring-border"
          key={`${part}:${index.toString()}`}
        >
          {part}
        </span>
      )
    }

    return part
  })

export function VideoPromptReadingView({ prompt }: { prompt: string }) {
  const segments = formatVideoPromptReadingSegments(prompt)

  if (segments.length === 0) {
    return (
      <p className="border-t border-border pt-6 text-canvas-body text-on-surface-variant">
        暂无可展示的视频提示词。
      </p>
    )
  }

  return (
    <article className="space-y-4 border-t border-border pt-6" data-video-prompt-reading="true">
      {segments.map((segment, index) => (
        <section
          className="rounded-md border border-border bg-glass-surface px-5 py-4"
          data-video-prompt-segment="true"
          key={`${segment.label}:${index.toString()}`}
        >
          <div className="mb-3 flex items-center gap-3">
            <span
              className={cn(
                'inline-flex h-7 shrink-0 items-center rounded-full px-3 text-body leading-none font-semibold tracking-[0]',
                segment.variant === 'timed'
                  ? 'bg-chat-agent-rail text-background'
                  : 'bg-control-bg text-on-background ring-1 ring-border',
              )}
            >
              {segment.label}
            </span>
          </div>
          <p className="text-canvas-body leading-[1.86] font-medium tracking-[0] text-on-background">
            {renderVideoPromptText(segment.body)}
          </p>
        </section>
      ))}
    </article>
  )
}

/**
 * 渲染复制提示词图标。
 *
 * @returns 复制 SVG 图标。
 */
export function CopyIcon() {
  return (
    <svg
      aria-hidden="true"
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      fill="currentColor"
      viewBox="0 0 256 256"
    >
      <title>复制提示词</title>
      <path d="M216,32H88a8,8,0,0,0-8,8V80H40a8,8,0,0,0-8,8V216a8,8,0,0,0,8,8H168a8,8,0,0,0,8-8V176h40a8,8,0,0,0,8-8V40A8,8,0,0,0,216,32ZM160,208H48V96H160Zm48-48H176V88a8,8,0,0,0-8-8H96V48H208Z" />
    </svg>
  )
}

/**
 * 渲染提示词修改图标。
 *
 * @returns 修改 SVG 图标。
 */
export function PencilIcon() {
  return (
    <svg
      aria-hidden="true"
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      fill="currentColor"
      viewBox="0 0 256 256"
    >
      <title>修改提示词</title>
      <path d="M227.31,73.37,182.63,28.68a16,16,0,0,0-22.63,0L36.69,152A15.86,15.86,0,0,0,32,163.31V208a16,16,0,0,0,16,16H92.69A15.86,15.86,0,0,0,104,219.31L227.31,96A16,16,0,0,0,227.31,73.37ZM92.69,208H48V163.31l88-88L180.69,120ZM192,108.68,147.31,64,171.31,40,216,84.68Z" />
    </svg>
  )
}

/**
 * 渲染复制完成图标。
 *
 * @returns 完成 SVG 图标。
 */
export function CheckIcon() {
  return (
    <svg
      aria-hidden="true"
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      fill="currentColor"
      viewBox="0 0 256 256"
    >
      <title>复制完成</title>
      <path d="M229.66,77.66l-128,128a8,8,0,0,1-11.32,0l-56-56a8,8,0,0,1,11.32-11.32L96,188.69,218.34,66.34a8,8,0,0,1,11.32,11.32Z" />
    </svg>
  )
}
