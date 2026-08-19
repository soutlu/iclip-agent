import { Fragment, type MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ShotByShotScriptGroup,
  ShotByShotScriptModel,
  ShotByShotScriptSegment,
} from '@/features/artifacts/renderers/shot-by-shot-script.utils'
import type { MarkdownArtifactOutput } from '@/features/artifacts/types/markdown.types'
import { cn } from '@/shared/lib/utils'
import HippoIcon from '@/shared/ui/icons/HippoIcon'

interface ShotByShotScriptCanvasCardProps {
  markdown: MarkdownArtifactOutput
  script: ShotByShotScriptModel
  variant?: 'canvas' | 'focused'
}

interface ShotByShotScriptEntry {
  groupRangeLabel: string
  groupTitle: string
  segment: ShotByShotScriptSegment
  startsGroup: boolean
}

type ShotByShotCopyStatus = 'copied' | 'failed' | 'idle'

const COPY_STATUS_RESET_DELAY_MS = 1400

/**
 * 停止画布节点拖拽或选择事件继续冒泡。
 *
 * @param event - 当前交互事件。
 */
const stopActionPropagation = (event: { stopPropagation: () => void }) => {
  event.stopPropagation()
}

/**
 * 尝试使用浏览器 Clipboard API 写入文本。
 *
 * @param text - 需要复制的逐镜拉片表 Markdown。
 * @returns 写入成功时返回 true；API 不可用或权限拒绝时返回 false。
 */
const writeTextWithClipboardApi = async (text: string) => {
  if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
    return false
  }

  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/**
 * 使用隐藏 textarea 选择文本作为剪贴板写入的第二路径。
 *
 * @param text - 需要复制的逐镜拉片表 Markdown。
 * @returns 浏览器接受复制命令时返回 true。
 */
const writeTextWithSelectionCopy = (text: string) => {
  if (typeof document === 'undefined' || !document.body) {
    return false
  }

  const previousActiveElement =
    document.activeElement instanceof HTMLElement ? document.activeElement : null
  const textArea = document.createElement('textarea')

  textArea.value = text
  textArea.setAttribute('readonly', '')
  textArea.style.left = '-9999px'
  textArea.style.opacity = '0'
  textArea.style.position = 'fixed'
  textArea.style.top = '0'
  document.body.append(textArea)
  textArea.focus()
  textArea.select()

  try {
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    textArea.remove()
    try {
      previousActiveElement?.focus({ preventScroll: true })
    } catch {
      // 焦点恢复失败可忽略（元素可能已卸载）。
    }
  }
}

/**
 * 写入文本到系统剪贴板；Clipboard API 不可用时改用显式选择复制。
 *
 * @param text - 需要复制的逐镜拉片表 Markdown。
 * @returns 任一复制路径成功时返回 true。
 */
const writeTextToClipboard = async (text: string) => {
  const didWriteWithClipboardApi = await writeTextWithClipboardApi(text)

  if (didWriteWithClipboardApi) {
    return true
  }

  return writeTextWithSelectionCopy(text)
}

/**
 * 读取复制按钮当前应展示的文案。
 *
 * @param copyStatus - 当前复制状态。
 * @returns 复制按钮文案。
 */
const getCopyButtonLabel = (copyStatus: ShotByShotCopyStatus) => {
  if (copyStatus === 'copied') {
    return '已复制'
  }

  if (copyStatus === 'failed') {
    return '复制失败'
  }

  return '复制'
}

/**
 * 创建分组在时间线侧栏显示的起止范围。
 *
 * @param group - 逐镜拉片表分组。
 * @returns 分组首尾时间范围；缺少时间时返回空字符串。
 */
const createGroupRangeLabel = (group: ShotByShotScriptGroup): string => {
  const firstSegment = group.segments[0]
  const lastSegment = group.segments.at(-1)
  const firstStart = firstSegment?.rangeLabel.split('-')[0]
  const lastEnd = lastSegment?.rangeLabel.split('-').at(-1)

  return firstStart && lastEnd ? `${firstStart}-${lastEnd}` : ''
}

/**
 * 将逐镜脚本分组拍平成渲染行。
 *
 * @param groups - 逐镜脚本分组。
 * @returns 带分组起始标记的脚本条目列表。
 */
const flattenScriptGroups = (groups: ShotByShotScriptGroup[]): ShotByShotScriptEntry[] =>
  groups.flatMap((group) => {
    const groupRangeLabel = createGroupRangeLabel(group)

    return group.segments.map((segment, segmentIndex) => ({
      groupRangeLabel,
      groupTitle: group.title,
      segment,
      startsGroup: segmentIndex === 0,
    }))
  })

/**
 * 渲染时间线左侧单元格。
 *
 * @param props - 时间线条目属性。
 * @returns 时间线单元格元素。
 */
function ScriptTimelineCell({ entry }: { entry: ShotByShotScriptEntry }) {
  return (
    <div
      className="relative min-h-[118px] border-r border-[color:var(--color-border)] px-7 py-5"
      data-shot-by-shot-timeline-row="true"
    >
      <span
        aria-hidden="true"
        className="absolute top-0 bottom-0 left-[34px] w-px bg-[color:var(--color-chat-agent-rail)] opacity-55"
      />
      {entry.startsGroup ? (
        <span
          aria-hidden="true"
          className="absolute top-[31px] left-[29px] size-3 rounded-full bg-[color:var(--color-chat-agent-rail)]"
        />
      ) : null}
      <div className="relative pl-7">
        {entry.startsGroup ? (
          <div className="rounded-xl border border-[color:var(--color-border)] bg-[color:var(--color-control-bg)] px-3 py-3">
            <h3
              className="text-canvas-body leading-[1.35] font-semibold tracking-[0] text-[color:var(--color-on-background)]"
              data-shot-by-shot-timeline-title="true"
            >
              {entry.groupTitle}
            </h3>
            {entry.groupRangeLabel ? (
              <p className="mt-2 text-label leading-none font-medium text-[color:var(--color-on-surface-variant)]">
                {entry.groupRangeLabel}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}

/**
 * 渲染逐镜脚本文案单元格。
 *
 * @param props - 脚本文案条目属性。
 * @returns 单条脚本文案元素。
 */
function ScriptSegmentCell({ entry }: { entry: ShotByShotScriptEntry }) {
  const { segment } = entry

  return (
    <article
      className="min-h-[112px] border-b border-[color:var(--color-border)] px-7 py-5"
      data-shot-by-shot-script-row="true"
    >
      {entry.startsGroup ? (
        <p className="mb-2 h-6 text-right text-body-sm leading-4 font-semibold text-[color:var(--color-chat-muted-text)] uppercase">
          {entry.groupTitle}
        </p>
      ) : null}
      <div className="grid grid-cols-[176px_minmax(0,1fr)] gap-6">
        <div className="min-w-0">
          <span className="inline-flex rounded-lg border border-[color:var(--color-chat-agent-rail)] bg-[color:var(--color-chat-inline-bg)] px-3 py-1.5 text-body leading-none font-semibold text-[color:var(--color-chat-agent-rail)]">
            {segment.startTime}-{segment.endTime}
          </span>
        </div>
        <div className="min-w-0">
          <h4
            className="text-canvas-body leading-[1.35] font-semibold tracking-[0] text-[color:var(--color-on-background)]"
            data-shot-by-shot-segment-title="true"
          >
            {segment.title}
          </h4>
          <p
            className="mt-2 text-canvas-label leading-[1.68] font-medium tracking-[0] text-[color:var(--color-chat-secondary-text)]"
            data-shot-by-shot-segment-description="true"
          >
            {segment.text}
          </p>
        </div>
      </div>
    </article>
  )
}

/**
 * 渲染逐镜脚本的时间线和阅读区。
 *
 * @param props - 逐镜脚本分组属性。
 * @returns 时间线与阅读区元素。
 */
function ScriptTimelineAndReading({ groups }: { groups: ShotByShotScriptGroup[] }) {
  const entries = useMemo(() => flattenScriptGroups(groups), [groups])

  return (
    <section
      aria-label="逐镜脚本阅读区"
      className="thin-scrollbar h-full min-h-0 overflow-y-auto overscroll-contain"
      data-scrollable
      data-shot-by-shot-script-body="true"
    >
      <div className="grid min-w-[870px] grid-cols-[300px_minmax(0,1fr)]">
        <div
          className="layer-local-1 sticky top-0 border-r border-b border-[color:var(--color-border)] bg-[color:var(--color-background)] px-7 py-5"
          data-shot-by-shot-timeline="true"
        >
          <p className="text-body-sm leading-none font-semibold text-[color:var(--color-on-background)]">
            时间线
          </p>
        </div>
        <div className="layer-local-1 sticky top-0 border-b border-[color:var(--color-border)] bg-[color:var(--color-background)] px-7 py-5">
          <p className="text-body-sm leading-none font-semibold text-[color:var(--color-on-background)]">
            镜头脚本
          </p>
        </div>
        {entries.map((entry) => (
          <Fragment key={`${entry.groupTitle}:${entry.segment.startTime}:${entry.segment.endTime}`}>
            <ScriptTimelineCell entry={entry} />
            <ScriptSegmentCell entry={entry} />
          </Fragment>
        ))}
      </div>
    </section>
  )
}

/**
 * 渲染逐镜脚本画布卡片。
 *
 * @param props - 逐镜脚本 Markdown、解析模型和显示形态。
 * @returns 逐镜脚本卡片元素。
 */
export default function ShotByShotScriptCanvasCard({
  markdown,
  script,
  variant = 'canvas',
}: ShotByShotScriptCanvasCardProps) {
  const [copyStatus, setCopyStatus] = useState<ShotByShotCopyStatus>('idle')
  const copyResetTimerRef = useRef<ReturnType<typeof globalThis.setTimeout> | null>(null)
  const isCopied = copyStatus === 'copied'
  const isCopyFailed = copyStatus === 'failed'
  const isFocused = variant === 'focused'
  const copyButtonLabel = getCopyButtonLabel(copyStatus)

  useEffect(
    () => () => {
      if (copyResetTimerRef.current !== null) {
        globalThis.clearTimeout(copyResetTimerRef.current)
      }
    },
    [],
  )

  const scheduleCopyStatusReset = useCallback(() => {
    if (copyResetTimerRef.current !== null) {
      globalThis.clearTimeout(copyResetTimerRef.current)
    }

    copyResetTimerRef.current = globalThis.setTimeout(() => {
      setCopyStatus('idle')
      copyResetTimerRef.current = null
    }, COPY_STATUS_RESET_DELAY_MS)
  }, [])

  const handleCopyMarkdown = useCallback(
    async (event: MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation()

      const didCopy = await writeTextToClipboard(markdown.markdown)
      setCopyStatus(didCopy ? 'copied' : 'failed')
      scheduleCopyStatusReset()
    },
    [markdown.markdown, scheduleCopyStatusReset],
  )

  return (
    <article
      className={cn(
        'relative flex w-full flex-col overflow-hidden border border-[color:var(--color-border)] bg-[color:var(--color-background)] font-[var(--font-producer-ui)] text-[color:var(--color-on-background)] shadow-[var(--shadow-3)]',
        isFocused ? 'min-h-full rounded-l-xl rounded-r-none' : 'h-full min-h-0',
      )}
      data-shot-by-shot-script-card="true"
    >
      <header className="flex shrink-0 items-center justify-between gap-6 border-b border-[color:var(--color-border)] px-8 py-6">
        <div className="min-w-0">
          <h2 className="truncate text-canvas-title-lg leading-none font-semibold tracking-[0]">
            {script.title}
          </h2>
          <p className="mt-3 truncate text-body leading-none font-medium text-[color:var(--color-on-surface-variant)]">
            {script.durationLabel} · {script.segmentCount.toString()} 个时间段 · Shot-by-Shot Script
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-3">
          <span className="inline-flex h-9 items-center gap-2 rounded-full border border-[color:var(--color-border)] bg-[color:var(--color-control-bg)] px-3 text-body-sm font-semibold text-[color:var(--color-chat-agent-rail)]">
            <span
              aria-hidden="true"
              className="size-1.5 rounded-full bg-[color:var(--color-chat-agent-rail)]"
            />
            已解析
          </span>
          <div className="flex flex-col items-end gap-1">
            <button
              aria-label={isCopied ? '已复制逐镜拉片表' : '复制逐镜拉片表'}
              className={cn(
                'nodrag nopan inline-flex h-9 items-center gap-2 rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-control-bg)] px-3 text-body-sm font-semibold text-[color:var(--color-on-background)] transition-colors hover:bg-[color:var(--color-hover)]',
                isCopyFailed
                  ? 'border-[color:var(--color-danger-border)] text-[color:var(--color-danger-text)]'
                  : '',
              )}
              onClick={(event) => {
                void handleCopyMarkdown(event)
              }}
              onPointerDown={stopActionPropagation}
              title={isCopied ? '已复制' : '复制'}
              type="button"
            >
              <span>{copyButtonLabel}</span>
              <HippoIcon aria-hidden="true" name={isCopied ? 'complete' : 'copy'} size={15} />
            </button>
            {isCopyFailed ? (
              <span className="text-label leading-none font-medium text-[color:var(--color-danger-text)]">
                无法访问剪贴板
              </span>
            ) : null}
          </div>
        </div>
      </header>

      <section className="min-h-0 flex-1">
        <ScriptTimelineAndReading groups={script.groups} />
      </section>

      <footer className="flex shrink-0 items-center justify-between border-t border-[color:var(--color-border)] px-8 py-5">
        <span className="rounded-lg bg-[color:var(--color-control-bg)] px-3 py-2 text-body-sm font-semibold text-[color:var(--color-on-surface-variant)]">
          脚本就绪 · {script.segmentCount.toString()} 段
        </span>
      </footer>
    </article>
  )
}
