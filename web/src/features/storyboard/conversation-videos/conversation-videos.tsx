import { useRef, useState, type RefObject } from 'react'
import { errorMessageOf } from '@/shared/api/client'
import { cn } from '@/shared/lib/utils'
import { Button, IconButton } from '@/shared/ui/button'
import { MediaFallback } from '@/shared/ui/media-fallback'
import { MediaLightbox, type LightboxMedia } from '@/shared/ui/media-lightbox'
import { GenerationDownload } from '../components/generation-download'
import { useLiveGenerations } from '../use-live-generations'
import { useConversationVideos } from './conversation-videos.api'
import type { ConversationVideoGroup } from './video-groups'

type ConversationVideosProps = {
  conversationId: string
  /** 宿主暂停其他对话的播放器；放大预览打开前调用。 */
  onBeforePreview?: (() => void) | undefined
}

/** 需求单关联对话的视频浏览区；对话信息与访问权限由上层负责。 */
export function ConversationVideos({ conversationId, onBeforePreview }: ConversationVideosProps) {
  const query = useConversationVideos(conversationId)
  useLiveGenerations(conversationId)
  const contentRef = useRef<HTMLDivElement>(null)
  const [preview, setPreview] = useState<LightboxMedia | null>(null)

  const pauseVideos = (playing?: EventTarget) => {
    contentRef.current?.querySelectorAll('video').forEach((video) => {
      if (video !== playing && !video.paused) video.pause()
    })
  }

  if (query.isPending) {
    return (
      <p className="py-3 text-body-sm text-on-surface-muted" role="status">
        正在读取视频…
      </p>
    )
  }

  return (
    <>
      <div
        className="flex min-w-0 flex-col gap-4"
        onPlayCapture={(event) => pauseVideos(event.target)}
        ref={contentRef}
      >
        {query.isError ? (
          <div className="flex flex-wrap items-center gap-2 text-body-sm text-error" role="alert">
            <p className="min-w-0 flex-1 break-words">
              {errorMessageOf(query.error, '读取视频记录失败')}
            </p>
            <Button
              loading={query.isFetching}
              onClick={() => void query.refetch()}
              size="md"
              variant="ghost"
            >
              重试
            </Button>
          </div>
        ) : null}
        {query.data?.map((group) => (
          <VideoGroup
            group={group}
            key={`${conversationId}-${group.id}`}
            onPreview={(media) => {
              pauseVideos()
              onBeforePreview?.()
              setPreview(media)
            }}
          />
        ))}
        {!query.isError && query.data?.length === 0 ? (
          <p className="py-2 text-body-sm text-on-surface-muted">暂无视频产物</p>
        ) : null}
      </div>
      <MediaLightbox media={preview} onClose={() => setPreview(null)} />
    </>
  )
}

type VideoGroupProps = {
  group: ConversationVideoGroup
  onPreview: (media: LightboxMedia) => void
}

function VideoGroup({ group, onPreview }: VideoGroupProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const selected = group.videos.find((video) => video.id === selectedId) ?? group.videos.at(-1)
  if (selected === undefined) return null

  return (
    <section aria-label={group.label} className="flex min-w-0 flex-col gap-2">
      <div className="flex items-center gap-2">
        <h4 className="min-w-0 flex-1 text-label font-medium text-on-surface">{group.label}</h4>
        <IconButton
          label={`放大${group.label}`}
          name="maximize-panel"
          onClick={() => onPreview({ kind: 'video', name: group.label, url: selected.outputUrl })}
          size="sm"
        />
        <GenerationDownload url={selected.outputUrl} watermarkUrl={selected.watermarkOutputUrl} />
      </div>
      {group.videos.length > 1 ? (
        <div
          aria-label={`${group.label}版本`}
          className="flex gap-1 overflow-x-auto py-1"
          role="group"
        >
          {group.videos.toReversed().map((video, index) => {
            const version = group.videos.length - index
            return (
              <button
                aria-label={`${group.label} V${version}`}
                aria-pressed={video.id === selected.id}
                className={cn(
                  'h-(--control-height-sm) shrink-0 ui-state cursor-pointer rounded-sm px-3 text-label ui-focus',
                  video.id === selected.id
                    ? 'bg-secondary-container font-medium text-on-secondary-container'
                    : 'text-on-surface-muted',
                )}
                key={video.id}
                onClick={() => {
                  videoRef.current?.pause()
                  setSelectedId(video.id)
                }}
                type="button"
              >
                V{version}
              </button>
            )
          })}
        </div>
      ) : null}
      <VideoPlayer key={selected.id} label={group.label} ref={videoRef} url={selected.outputUrl} />
    </section>
  )
}

type VideoPlayerProps = {
  label: string
  ref: RefObject<HTMLVideoElement | null>
  url: string
}

function VideoPlayer({ label, ref, url }: VideoPlayerProps) {
  const [failed, setFailed] = useState(false)

  return (
    <div className="relative h-60 overflow-hidden rounded-sm bg-scrim">
      {/* eslint-disable-next-line jsx-a11y-x/media-has-caption -- 生成接口没有提供字幕轨。 */}
      <video
        aria-label={`${label}视频`}
        className="size-full object-contain"
        controls
        hidden={failed}
        onError={() => setFailed(true)}
        playsInline
        preload="metadata"
        ref={ref}
        src={url}
      />
      {failed ? (
        <div
          className="absolute inset-0 grid place-items-center bg-surface-container p-4"
          role="alert"
        >
          <MediaFallback
            kind="video"
            onRetry={() => {
              setFailed(false)
              ref.current?.load()
            }}
          />
        </div>
      ) : null}
    </div>
  )
}
