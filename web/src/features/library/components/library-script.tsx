/** 详情右栏的两页：脚本（全局设定、逐镜正文、参考图、同一次创作的其他镜）与参数（出片请求的参数和来源）。 */

import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { formatDateTime } from '@/shared/lib/date-time'
import { imageThumbnailUrl, videoSnapshotUrl } from '@/shared/lib/media-url'
import { cn } from '@/shared/lib/utils'
import type { LightboxMedia } from '@/shared/ui/media-lightbox'
import type { LibraryTake, LibraryVideo } from '../library.api'
import {
  aspectOf,
  cutIndexAt,
  durationSecondsOf,
  formatSecond,
  promptSegmentsOf,
  type LibraryVersion,
} from '../library-media'

function SectionHeading({ title, note }: { title: string; note?: string }) {
  return (
    <h3 className="mt-6 mb-2.5 flex items-baseline justify-between gap-3 text-body-sm font-semibold text-on-surface first:mt-0">
      {title}
      {note === undefined ? null : (
        <span className="text-caption font-normal text-on-surface-faint">{note}</span>
      )}
    </h3>
  )
}

/** 正文里的 `@ImageN` 换成带缩略图的小标，指向第 N 张参考图。 */
function PromptText({ text, take }: { text: string; take: LibraryTake }) {
  return promptSegmentsOf(text, take.referenceImageUrls).map((segment) =>
    segment.kind === 'text' ? (
      <span key={segment.start}>{segment.text}</span>
    ) : (
      <span
        className="mx-0.5 inline-flex h-5.5 items-center gap-1 rounded-xs bg-surface-container px-1.5 align-middle text-caption text-on-surface-variant"
        key={segment.start}
      >
        <img
          alt=""
          className="h-4.5 rounded-xs bg-surface-container-high object-contain"
          src={imageThumbnailUrl(segment.url, 'resize,l_80')}
        />
        图{segment.number}
      </span>
    ),
  )
}

type LibraryScriptPanelProps = {
  take: LibraryTake
  /** 正在播的秒数，用来标出当前那一镜。 */
  currentTime: number
  onSeek: (seconds: number) => void
  onPreviewImage: (media: LightboxMedia) => void
  /** 同一段对话的其他镜；详情还没读回来是 undefined。 */
  siblings: readonly LibraryVideo[] | undefined
  onOpenSibling: (id: string) => void
}

export function LibraryScriptPanel({
  take,
  currentTime,
  onSeek,
  onPreviewImage,
  siblings,
  onOpenSibling,
}: LibraryScriptPanelProps) {
  const { script } = take
  const active = script === null ? -1 : cutIndexAt(script, currentTime)

  return (
    <>
      {script === null ? (
        <>
          <SectionHeading note="纯文本，没有分镜结构" title="提示词" />
          <p className="rounded-md bg-surface-container-low px-3.5 py-3 text-body-sm whitespace-pre-wrap text-on-surface-variant">
            <PromptText take={take} text={take.prompt} />
          </p>
        </>
      ) : (
        <>
          <SectionHeading title="全局设定" />
          <p className="rounded-md bg-surface-container-low px-3.5 py-3 text-body-sm whitespace-pre-wrap text-on-surface-variant">
            <PromptText take={take} text={script.globalSettings} />
          </p>

          <SectionHeading
            note={`${script.timeline.length} 个镜头 · ${formatSecond(script.timeline.at(-1)?.end ?? 0)} 秒 · 点镜头跳到对应画面`}
            title="分镜"
          />
          <div aria-hidden className="mb-3.5 flex h-1.5 gap-0.5">
            {script.timeline.map((cut, order) => (
              <span
                className={cn(
                  'rounded-full ui-motion-s',
                  order === active ? 'bg-on-surface' : 'bg-surface-container-highest',
                )}
                key={cut.start}
                style={{ flex: `${cut.end - cut.start} 1 0` }}
              />
            ))}
          </div>
          <ol className="grid gap-0.5">
            {script.timeline.map((cut, order) => (
              <li key={cut.start}>
                <button
                  aria-current={order === active ? 'step' : undefined}
                  aria-label={`镜头 ${order + 1}，${formatSecond(cut.start)} 秒起`}
                  className={cn(
                    'grid w-full ui-state cursor-pointer grid-cols-[22px_1fr] gap-2.5 rounded-sm py-2.5 pr-2.5 pl-1.5 text-left ui-focus',
                    order === active && 'bg-state-active',
                  )}
                  onClick={() => onSeek(cut.start)}
                  type="button"
                >
                  <span
                    className={cn(
                      'grid size-5.5 place-items-center rounded-full text-caption tabular-nums',
                      order === active
                        ? 'bg-on-surface text-surface'
                        : 'border border-hairline text-on-surface-variant',
                    )}
                  >
                    {order + 1}
                  </span>
                  <span className="min-w-0">
                    <span className="block font-mono text-caption text-on-surface-faint">
                      {formatSecond(cut.start)}–{formatSecond(cut.end)}s
                    </span>
                    <span className="mt-0.5 block text-body-sm text-on-surface">
                      <PromptText take={take} text={cut.prompt} />
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </>
      )}

      {take.referenceImageUrls.length === 0 ? null : (
        <>
          <SectionHeading
            note={`${take.referenceImageUrls.length} 张 · 正文里的「图N」`}
            title="参考图"
          />
          <div className="flex flex-wrap gap-2">
            {take.referenceImageUrls.map((url, order) => (
              <button
                aria-label={`查看参考图 ${order + 1}`}
                className="relative cursor-zoom-in overflow-hidden rounded-sm bg-surface-container ui-focus"
                key={url}
                onClick={() => onPreviewImage({ kind: 'image', name: `参考图 ${order + 1}`, url })}
                type="button"
              >
                <img
                  alt=""
                  className="block h-22 object-contain"
                  loading="lazy"
                  src={imageThumbnailUrl(url, 'resize,h_176')}
                />
                <span className="library-card-badge absolute top-1 left-1">图{order + 1}</span>
              </button>
            ))}
          </div>
        </>
      )}

      {siblings === undefined || siblings.length === 0 ? null : (
        <>
          <SectionHeading note={`${siblings.length} 条`} title="同一次创作的其他镜头组" />
          <div className="grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-2.5">
            {siblings.map((sibling) => (
              <SiblingCard key={sibling.id} onOpen={onOpenSibling} video={sibling} />
            ))}
          </div>
        </>
      )}
    </>
  )
}

function SiblingCard({ video, onOpen }: { video: LibraryVideo; onOpen: (id: string) => void }) {
  const { w, h } = aspectOf(video.take.aspectRatio)
  const poster = videoSnapshotUrl(video.face.outputUrl, 240)
  const seconds = durationSecondsOf(video)
  return (
    <button
      className="cursor-pointer rounded-sm text-left ui-focus"
      onClick={() => onOpen(video.id)}
      type="button"
    >
      <span
        className="relative block overflow-hidden rounded-sm bg-surface-container-low"
        style={{ aspectRatio: `${w} / ${h}` }}
      >
        {poster === undefined ? null : (
          <img alt="" className="size-full object-contain" loading="lazy" src={poster} />
        )}
      </span>
      <span className="mt-1.5 block text-caption font-medium text-on-surface">
        {video.shotIndex === null ? '接口提交' : `镜头组 ${video.shotIndex}`}
      </span>
      <span className="block truncate text-caption text-on-surface-faint">
        {[seconds === null ? null : `${formatSecond(seconds)} 秒`, video.take.model]
          .filter(Boolean)
          .join(' · ')}
      </span>
    </button>
  )
}

type LibraryParamsPanelProps = {
  video: LibraryVideo
  version: LibraryVersion
  /** 详情读回来之前不知道是第几版，不显示。 */
  showVersion: boolean
}

/** 请求里没有的参数整行不显示，不编默认值。 */
export function LibraryParamsPanel({ video, version, showVersion }: LibraryParamsPanelProps) {
  const { take } = version
  const seconds = version.durationMs === null ? durationSecondsOf(video) : version.durationMs / 1000
  const rows: [string, ReactNode][] = []
  if (take.model !== null) rows.push(['模型', take.model])
  if (take.aspectRatio !== null) rows.push(['画幅', take.aspectRatio])
  if (seconds !== null) rows.push(['时长', `${formatSecond(seconds)} 秒`])
  if (take.resolution !== null) rows.push(['分辨率', take.resolution])
  if (take.generateAudio !== null) rows.push(['音频', take.generateAudio ? '生成' : '不生成'])
  if (showVersion)
    rows.push([
      '版本',
      version.kind === 'master' ? `${version.label}（编辑后合成）` : version.label,
    ])
  if (take.userName !== null) rows.push(['作者', take.userName])
  rows.push(['生成时间', formatDateTime(version.createdAt)])
  if (video.conversationId !== null) {
    rows.push([
      '来源对话',
      <Link
        className="text-on-surface underline decoration-hairline underline-offset-4 ui-focus hover:decoration-on-surface"
        key="conversation"
        params={{ conversationId: video.conversationId }}
        to="/c/$conversationId"
      >
        {video.title ?? '打开对话'}
      </Link>,
    ])
  }

  return (
    <dl className="grid grid-cols-[88px_1fr] gap-3 text-body-sm">
      {rows.map(([term, value]) => (
        <div className="contents" key={term}>
          <dt className="text-on-surface-variant">{term}</dt>
          <dd className="min-w-0 break-words text-on-surface">{value}</dd>
        </div>
      ))}
    </dl>
  )
}
