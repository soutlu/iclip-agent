/**
 * 工具行：所有工具共用一个壳，四个插槽——图标、主区（标题 · 主语 · 箭头）、尾区（角标 · 状态）、卡身。
 * 卡身按 view 选：读文件带行号，检索逐条命中，媒体一排图，其余多行结果原文展开。
 */

import { useNavigate } from '@tanstack/react-router'
import { useState, type ReactNode } from 'react'
import type { ToolCallFrame } from '@/shared/transcript/vendor'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { type LightboxMedia, MediaLightbox } from '@/shared/ui/media-lightbox'
import { frameArtifactId, useWorkbenchSelection } from '@/shared/workbench'
import { DisclosureBody, DisclosureChevron } from './disclosure'
import {
  toolBodyText,
  toolCard,
  toolChip,
  toolDiff,
  toolMedia,
  toolResult,
  type MediaGridItem,
  type SearchMatch,
} from './tool-display'

type ToolLineProps = {
  frame: ToolCallFrame
  /** 轮次已结束时遗留的 running 当完成画，避免停止后一直转圈。 */
  settled: boolean
}

const STATUS = {
  done: { color: 'text-chat-status-success', label: '完成', name: 'success' },
  error: { color: 'text-chat-status-error', label: '出错', name: 'failed' },
  running: { color: 'text-chat-status-running', label: '进行中', name: 'loading' },
} as const

export function ToolLine({ frame, settled }: ToolLineProps) {
  const card = toolCard(frame.display, frame.view)
  const state = frame.state === 'running' && settled ? 'done' : frame.state
  const status = STATUS[state]
  const [open, setOpen] = useState(false)
  const [preview, setPreview] = useState<LightboxMedia | null>(null)
  const media = toolMedia(frame)
  const body = toolBody(frame)
  const delegated = (frame.agentRefs?.length ?? 0) > 0

  const head = (
    <>
      <Icon className="shrink-0 text-chat-muted-text" decorative name={card.icon} size="sm" />
      <span className="shrink-0 text-chat-secondary-text">{card.label}</span>
      {card.detail === undefined ? null : (
        <span
          className={cn(
            'max-w-[60%] min-w-0 truncate text-chat-message-text',
            card.mono && 'font-mono text-body-sm',
          )}
        >
          {card.detail}
        </span>
      )}
      {body === null ? null : (
        <DisclosureChevron className="shrink-0 text-chat-muted-text" open={open} />
      )}
      <span className="ml-auto flex shrink-0 items-center gap-2">
        <Tail frame={frame} />
        <Icon
          className={cn('shrink-0', status.color, state === 'running' && 'animate-spin')}
          label={status.label}
          name={status.name}
          size="sm"
        />
      </span>
    </>
  )

  return (
    <div className="flex flex-col">
      {delegated ? (
        <DelegatedHead toolCallId={frame.toolCallId}>{head}</DelegatedHead>
      ) : body === null ? (
        <div className="flex items-center gap-1.5 py-1.5 text-body">{head}</div>
      ) : (
        <>
          <button
            aria-expanded={open}
            className="flex w-full cursor-pointer items-center gap-1.5 rounded-xs py-1.5 text-left text-body ui-focus"
            onClick={() => setOpen(!open)}
            type="button"
          >
            {head}
          </button>
          <DisclosureBody open={open}>{body}</DisclosureBody>
        </>
      )}
      {media.length === 0 ? null : <MediaWall items={media} onOpen={setPreview} />}
      <MediaLightbox media={preview} onClose={() => setPreview(null)} />
      {frame.error === undefined ? null : (
        <p className="text-body-sm text-chat-error-text">{frame.error}</p>
      )}
    </div>
  )
}

/** 卡尾角标：改文件是增删数加一条小色条，其余是一段文字。 */
function Tail({ frame }: { frame: ToolCallFrame }) {
  const diff = toolDiff(frame)
  if (diff !== undefined) {
    return (
      <span className="flex items-center gap-1.5 font-mono text-body-sm tabular-nums">
        {diff.added > 0 ? <span className="text-chat-status-success">+{diff.added}</span> : null}
        {diff.removed > 0 ? <span className="text-chat-status-error">−{diff.removed}</span> : null}
        <span aria-hidden className="flex h-[3px] w-9 gap-px overflow-hidden rounded-full">
          <span className="bg-chat-status-success" style={{ flexGrow: diff.added }} />
          <span className="bg-chat-status-error" style={{ flexGrow: diff.removed }} />
        </span>
      </span>
    )
  }
  const chip = toolChip(frame)
  return chip === undefined ? null : (
    <span className="text-body-sm text-chat-muted-text tabular-nums">{chip}</span>
  )
}

/** 卡身按 view 选；没有可看的东西就不给展开。 */
function toolBody(frame: ToolCallFrame): ReactNode | null {
  const result = toolResult(frame)
  if (result?.kind === 'file_content' && typeof frame.output === 'string') {
    return <FileContentBody text={frame.output} />
  }
  if (result?.kind === 'search_results' && result.matches.length > 0) {
    return <SearchResultsBody matches={result.matches} truncated={result.truncated} />
  }
  const text = toolBodyText(frame)
  return text === undefined ? null : (
    <pre className="mt-1 max-h-64 overflow-auto rounded-sm bg-chat-code-block-bg px-3 py-2 font-mono text-body-sm whitespace-pre-wrap text-chat-secondary-text">
      {text}
    </pre>
  )
}

const NUMBERED_LINE = /^\s*(\d+)\t(.*)$/

/** 读文件的结果本来就带行号；行号一栏、正文一栏，读不完的那句提示放最后。 */
function FileContentBody({ text }: { text: string }) {
  const rows: { no: string; text: string }[] = []
  const notes: string[] = []
  for (const line of text.split('\n')) {
    const match = NUMBERED_LINE.exec(line)
    if (match) rows.push({ no: match[1] ?? '', text: match[2] ?? '' })
    else if (line.trim() !== '') notes.push(line)
  }
  return (
    <div className="mt-1 max-h-72 overflow-auto rounded-sm border-[0.5px] border-chat-hairline bg-chat-code-block-bg py-2 font-mono text-body-sm">
      {rows.map((row) => (
        <div className="grid grid-cols-[3rem_1fr]" key={row.no}>
          <span className="pr-3 text-right text-chat-muted-text tabular-nums select-none">
            {row.no}
          </span>
          <span className="pr-3 whitespace-pre text-chat-message-text">{row.text}</span>
        </div>
      ))}
      {notes.map((note) => (
        <p className="px-3 pt-1 text-chat-muted-text" key={note}>
          {note}
        </p>
      ))}
    </div>
  )
}

/** 检索结果逐条：文件与行号在前，命中的那一行在后。 */
function SearchResultsBody({
  matches,
  truncated,
}: {
  matches: readonly SearchMatch[]
  truncated: boolean
}) {
  return (
    <ul className="mt-1 flex flex-col font-mono text-body-sm">
      {matches.map((match) => (
        <li
          className="flex items-baseline gap-2 rounded-xs px-2 py-0.5"
          key={`${match.file}:${match.line}:${match.text}`}
        >
          <span className="shrink-0 text-chat-secondary-text tabular-nums">
            {match.file}:{match.line}
          </span>
          <span className="min-w-0 truncate text-chat-message-text">{match.text}</span>
        </li>
      ))}
      {truncated ? (
        <li className="px-2 py-0.5 text-chat-muted-text">命中较多，只列出一部分</li>
      ) : null}
    </ul>
  )
}

/** 派出了子代理的卡：点开的是右侧面板里它那条流。产物参数记在 URL 上，刷新与分享都还在；再点一次也能把折叠的面板重新打开。 */
function DelegatedHead({ children, toolCallId }: { children: ReactNode; toolCallId: string }) {
  const navigate = useNavigate()
  const { requestOpen } = useWorkbenchSelection()
  return (
    <button
      aria-label="查看子代理过程"
      className="flex w-full cursor-pointer items-center gap-1.5 rounded-xs py-1.5 text-left text-body ui-focus"
      onClick={() => {
        requestOpen()
        void navigate({
          search: (previous: Record<string, unknown>) => ({
            ...previous,
            artifact: frameArtifactId(toolCallId),
          }),
          to: '.',
        })
      }}
      type="button"
    >
      {children}
      <Icon className="shrink-0 text-chat-muted-text" decorative name="panel-right" size="sm" />
    </button>
  )
}

function MediaWall({
  items,
  onOpen,
}: {
  items: readonly MediaGridItem[]
  onOpen: (media: LightboxMedia) => void
}) {
  return (
    <div className="flex flex-wrap gap-2 pt-1">
      {items.map((item) => (
        <figure
          className="flex max-w-[320px] min-w-0 flex-col gap-1.5 max-sm:w-[min(44vw,160px)]"
          key={item.url}
        >
          <button
            className="cursor-zoom-in overflow-hidden rounded-md ui-focus"
            onClick={() => onOpen({ kind: 'image', name: item.caption, url: item.url })}
            type="button"
          >
            <img alt={item.caption} className="block w-full rounded-md" src={item.url} />
          </button>
          <figcaption className="truncate text-body-sm text-chat-muted-text">
            {item.caption}
          </figcaption>
        </figure>
      ))}
    </div>
  )
}
