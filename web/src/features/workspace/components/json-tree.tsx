/** JSON 排成可折叠的树；图片地址显示成缩略图，点开走灯箱。解析不了就明说并退回原文。 */

import { useState } from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { MediaLightbox, type LightboxMedia } from '@/shared/ui/media-lightbox'
import { TextLines } from './text-lines'

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

const IMAGE_URL = /^(data:image\/|https?:\/\/.+\.(?:jpe?g|png|webp|gif|avif)(?:[?#].*)?$)/i
const VIDEO_URL = /^(data:video\/|https?:\/\/.+\.(?:mp4|mov|webm)(?:[?#].*)?$)/i
const ANY_URL = /^https?:\/\//i

const isContainer = (value: JsonValue): value is JsonValue[] | { [key: string]: JsonValue } =>
  typeof value === 'object' && value !== null

/** 只留最后一段，够认出是哪张图。 */
const tailOf = (url: string): string => {
  if (url.startsWith('data:')) return 'data:…'
  try {
    const { pathname } = new URL(url)
    return pathname.slice(pathname.lastIndexOf('/') + 1) || url
  } catch {
    return url
  }
}

const parse = (text: string): { value: JsonValue } | { error: string } => {
  try {
    return { value: JSON.parse(text) as JsonValue }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

export function JsonTree({ text }: { text: string }) {
  const [preview, setPreview] = useState<LightboxMedia | null>(null)
  const parsed = parse(text)

  if ('error' in parsed) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-body-sm text-chat-error-text" role="alert">
          不是合法的 JSON：{parsed.error}
        </p>
        <TextLines text={text} />
      </div>
    )
  }

  return (
    <>
      <ul className="font-mono text-body-sm leading-relaxed">
        <JsonNode onPreview={setPreview} value={parsed.value} />
      </ul>
      <MediaLightbox media={preview} onClose={() => setPreview(null)} />
    </>
  )
}

type JsonNodeProps = {
  name?: string
  value: JsonValue
  onPreview: (media: LightboxMedia) => void
}

function JsonNode({ name, onPreview, value }: JsonNodeProps) {
  const [open, setOpen] = useState(true)

  if (!isContainer(value)) {
    return (
      <li className="flex items-start gap-2 py-0.5 pl-4">
        {name === undefined ? null : <Key name={name} />}
        <JsonLeaf onPreview={onPreview} value={value} />
      </li>
    )
  }

  const entries: [string, JsonValue][] = Array.isArray(value)
    ? value.map((item, index) => [String(index), item])
    : Object.entries(value)
  const shape = Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`
  const label = name === undefined ? '根' : name

  return (
    <li>
      <button
        aria-expanded={open}
        aria-label={`${open ? '收起' : '展开'} ${label}`}
        className="flex cursor-pointer items-center gap-1 rounded-xs py-0.5 pr-2 text-left ui-focus hover:bg-state-hover"
        onClick={() => setOpen(!open)}
        type="button"
      >
        <Icon
          className={cn('shrink-0 text-on-surface-faint ui-motion-s', open && 'rotate-90')}
          decorative
          name="next"
          size="xs"
        />
        {name === undefined ? null : <Key name={name} />}
        <span className="text-on-surface-faint">{shape}</span>
      </button>
      {open ? (
        <ul className="ml-1.5 border-l-[0.5px] border-chat-hairline">
          {entries.map(([key, item]) => (
            <JsonNode key={key} name={key} onPreview={onPreview} value={item} />
          ))}
        </ul>
      ) : null}
    </li>
  )
}

function Key({ name }: { name: string }) {
  return <span className="shrink-0 text-on-surface-variant">{name}</span>
}

function JsonLeaf({
  onPreview,
  value,
}: {
  onPreview: (media: LightboxMedia) => void
  value: JsonValue
}) {
  if (typeof value === 'string') {
    if (IMAGE_URL.test(value)) {
      return (
        <span className="flex min-w-0 items-center gap-2">
          <button
            className="shrink-0 cursor-zoom-in overflow-hidden rounded-xs border-[0.5px] border-chat-hairline bg-thumb-fallback ui-focus"
            onClick={() => onPreview({ kind: 'image', name: tailOf(value), url: value })}
            type="button"
          >
            <img
              alt={`预览 ${tailOf(value)}`}
              className="block h-12 w-auto max-w-24 object-cover"
              src={value}
            />
          </button>
          <span className="truncate text-on-surface-faint">{tailOf(value)}</span>
        </span>
      )
    }
    if (VIDEO_URL.test(value) || ANY_URL.test(value)) {
      return (
        <a
          className="flex min-w-0 items-center gap-1 truncate text-chat-link-text hover:underline"
          href={value}
          rel="noreferrer noopener"
          target="_blank"
        >
          {VIDEO_URL.test(value) ? <Icon decorative name="video" size="xs" /> : null}
          <span className="truncate">{VIDEO_URL.test(value) ? tailOf(value) : value}</span>
        </a>
      )
    }
    return (
      <span className="min-w-0 wrap-anywhere whitespace-pre-wrap text-on-surface">{value}</span>
    )
  }
  if (value === null) return <span className="text-on-surface-faint italic">null</span>
  if (typeof value === 'number' || typeof value === 'boolean') {
    return <span className="text-on-surface tabular-nums">{String(value)}</span>
  }
  // 容器在 JsonNode 里已经分派掉了，走不到这里。
  return null
}
