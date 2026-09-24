/** 资料库详情：左边播这一镜的某个版本、下面排全部版本，右边是脚本与参数；上一条 / 下一条在已读的列表里走。 */

import { useNavigate } from '@tanstack/react-router'
import { useRef, useState, type KeyboardEvent } from 'react'
import { errorMessageOf } from '@/shared/api/client'
import { copyText } from '@/shared/lib/clipboard'
import { videoSnapshotUrl } from '@/shared/lib/media-url'
import { formatRelativeTime } from '@/shared/lib/relative-time'
import { Button, IconButton } from '@/shared/ui/button'
import { useCopyFeedback } from '@/shared/ui/copy-feedback'
import { DialogRoot, DialogSurface, DialogTitle } from '@/shared/ui/dialog'
import { MediaLightbox, type LightboxMedia } from '@/shared/ui/media-lightbox'
import { MenuItem, MenuRoot, MenuSurface, MenuTrigger } from '@/shared/ui/menu'
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from '@/shared/ui/tabs'
import { Tag } from '@/shared/ui/tag'
import { toast } from '@/shared/ui/toast'
import { VideoDownload } from '@/shared/ui/video-download'
import { useLibraryVideo, type LibraryVideo, type LibraryVideoDetail } from '../library.api'
import { snapshotWidthFor } from '../library-layout'
import {
  aspectOf,
  cardTitleOf,
  durationSecondsOf,
  formatSecond,
  versionsOf,
} from '../library-media'
import { AuthorAvatar } from './author-avatar'
import { LibraryParamsPanel, LibraryScriptPanel } from './library-script'

/** 点镜头跳过去时往后让一点，免得停在上一镜的最后一帧。 */
const SEEK_NUDGE_S = 0.05

type LibraryViewerProps = {
  videoId: string
  /** 列表里已读到的这一条；详情读回来之前先拿它铺画面和脚本。 */
  listed: LibraryVideo | undefined
  /** 从故事板点某一帧进来时，从这一秒开始播。 */
  startAt: number | null
  prevId: string | null
  nextId: string | null
  /** 这一条的分享地址，「复制链接」给它。 */
  shareLink: string
  onNavigate: (id: string) => void
  onClose: () => void
  onAuthor: (userName: string) => void
  /** 关掉后由列表把焦点放回卡片；卡片已被虚拟列表回收时返回 false，交给弹窗的默认去处。 */
  onRestoreFocus: () => boolean
}

export function LibraryViewer({
  videoId,
  listed,
  startAt,
  prevId,
  nextId,
  shareLink,
  onNavigate,
  onClose,
  onAuthor,
  onRestoreFocus,
}: LibraryViewerProps) {
  const detail = useLibraryVideo(videoId)
  const video = detail.data?.video ?? listed

  // 左右方向键翻上一条 / 下一条。嵌套的浮层（菜单、参考图大图）经 portal 冒泡上来，
  // 与视频进度条、页签一样自己用方向键，不抢。
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    const target = event.target
    if (
      !(target instanceof Element) ||
      target.closest('[role="dialog"]') !== event.currentTarget ||
      target.closest('video, [role="tablist"]') !== null
    )
      return
    const id = event.key === 'ArrowLeft' ? prevId : nextId
    if (id === null) return
    event.preventDefault()
    onNavigate(id)
  }

  return (
    <DialogRoot
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      open
    >
      <DialogSurface
        aria-describedby={undefined}
        bare
        className="inset-0 top-0 left-0 grid h-full max-h-none w-full max-w-none translate-x-0 translate-y-0 place-items-center max-sm:top-0 max-sm:max-h-none md:p-6 lg:px-22 lg:py-8"
        onCloseAutoFocus={(event) => {
          if (onRestoreFocus()) event.preventDefault()
        }}
        onKeyDown={onKeyDown}
        // 弹层铺满视口，框外的空白也在弹层里：按下落在空白处就关。
        onPointerDown={(event) => {
          if (event.target === event.currentTarget) onClose()
        }}
        overlayClassName="bg-scrim/60 backdrop-blur-sm"
      >
        <div className="relative flex size-full max-h-215 min-h-0 max-w-310 overflow-hidden bg-surface-container-lowest text-on-surface shadow-[var(--shadow-3)] max-md:flex-col max-md:overflow-y-auto md:rounded-2xl">
          {video === undefined ? (
            <ViewerPending
              error={detail.isError ? errorMessageOf(detail.error, '读取这条片子失败') : null}
              onClose={onClose}
              onRetry={() => void detail.refetch()}
            />
          ) : (
            <ViewerBody
              detail={detail.data}
              detailError={
                detail.isError ? errorMessageOf(detail.error, '读取这一镜的全部版本失败') : null
              }
              key={videoId}
              onAuthor={onAuthor}
              onClose={onClose}
              onNavigate={onNavigate}
              onRetry={() => void detail.refetch()}
              shareLink={shareLink}
              startAt={startAt}
              video={video}
            />
          )}
        </div>
        {/* 排在框后面：打开时焦点先落到框里的关闭按钮。 */}
        <NavButton direction="prev" id={prevId} onNavigate={onNavigate} />
        <NavButton direction="next" id={nextId} onNavigate={onNavigate} />
      </DialogSurface>
    </DialogRoot>
  )
}

function NavButton({
  direction,
  id,
  onNavigate,
}: {
  direction: 'prev' | 'next'
  id: string | null
  onNavigate: (id: string) => void
}) {
  return (
    <IconButton
      className={`library-viewer-glass absolute top-1/2 hidden size-12 -translate-y-1/2 rounded-full disabled:cursor-default disabled:opacity-30 lg:inline-grid ${direction === 'prev' ? 'left-5' : 'right-5'}`}
      disabled={id === null}
      label={direction === 'prev' ? '上一条' : '下一条'}
      name={direction === 'prev' ? 'back' : 'next'}
      onClick={() => {
        if (id !== null) onNavigate(id)
      }}
    />
  )
}

/** 分享来的链接指向的片子不在已读列表里：详情回来之前只有状态。 */
function ViewerPending({
  error,
  onClose,
  onRetry,
}: {
  error: string | null
  onClose: () => void
  onRetry: () => void
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
      <DialogTitle className="sr-only">资料库详情</DialogTitle>
      {error === null ? (
        <p className="text-body-sm text-on-surface-variant" role="status">
          正在读取…
        </p>
      ) : (
        <>
          <p className="text-body text-on-surface" role="alert">
            {error}
          </p>
          <div className="flex gap-2">
            <Button onClick={onRetry} size="md" variant="inverted">
              重试
            </Button>
            <Button onClick={onClose} size="md" variant="ghost">
              关闭
            </Button>
          </div>
        </>
      )}
    </div>
  )
}

type ViewerBodyProps = {
  video: LibraryVideo
  detail: LibraryVideoDetail | undefined
  detailError: string | null
  startAt: number | null
  shareLink: string
  onNavigate: (id: string) => void
  onClose: () => void
  onAuthor: (userName: string) => void
  onRetry: () => void
}

function ViewerBody({
  video,
  detail,
  detailError,
  startAt,
  shareLink,
  onNavigate,
  onClose,
  onAuthor,
  onRetry,
}: ViewerBodyProps) {
  const playerRef = useRef<HTMLVideoElement>(null)
  // 起播位置只对打开时那个版本生效一次，换版本从头播。
  const pendingStartRef = useRef(startAt)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [currentTime, setCurrentTime] = useState(0)
  const [preview, setPreview] = useState<LightboxMedia | null>(null)
  const { copied, copy } = useCopyFeedback()

  // 详情回来之前只有卡面那次出片，版本条等它回来再出。
  const versions = versionsOf(detail?.takes ?? [video.take])
  const version =
    versions.find((item) => item.id === (selectedId ?? video.face.jobId)) ?? versions.at(-1)
  if (version === undefined) return null

  const { w, h } = aspectOf(version.take.aspectRatio)
  const title = cardTitleOf(video)
  const author = version.take.userName
  const seconds = version.durationMs === null ? durationSecondsOf(video) : version.durationMs / 1000
  const tags = [
    version.take.model,
    version.take.aspectRatio,
    seconds === null ? null : `${formatSecond(seconds)} 秒`,
  ].filter((tag) => tag !== null)

  const seek = (at: number) => {
    const player = playerRef.current
    if (player === null) return
    player.currentTime = at + SEEK_NUDGE_S
    void player.play().catch(() => undefined)
  }

  return (
    <>
      <section
        aria-label="播放"
        className="library-viewer-stage relative flex min-w-0 flex-1 flex-col max-md:flex-none"
      >
        <IconButton
          className="library-viewer-glass layer-local-1 absolute top-4 right-4 size-10 rounded-full"
          label="关闭"
          name="close"
          onClick={onClose}
        />
        <div className="relative min-h-0 flex-1 max-md:h-[56vh] max-md:flex-none">
          <div className="absolute inset-3 md:inset-6">
            {/* eslint-disable-next-line jsx-a11y-x/media-has-caption -- 生成视频没有字幕轨可挂 */}
            <video
              aria-label={title}
              autoPlay
              className="size-full object-contain"
              controls
              key={version.id}
              loop
              onLoadedMetadata={(event) => {
                const at = pendingStartRef.current
                pendingStartRef.current = null
                if (at !== null) event.currentTarget.currentTime = at + SEEK_NUDGE_S
              }}
              onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
              playsInline
              poster={videoSnapshotUrl(version.outputUrl, 720)}
              ref={playerRef}
              src={version.outputUrl}
            />
          </div>
        </div>
        {detail === undefined || versions.length < 2 ? null : (
          <div
            aria-label="这一镜的版本"
            className="flex shrink-0 items-center gap-2 overflow-x-auto px-5 pb-4.5 max-md:px-3 max-md:pb-3"
            role="group"
          >
            <span className="library-viewer-faint mr-1 shrink-0 text-caption">这一镜的版本</span>
            {versions.map((item) => (
              <button
                aria-pressed={item.id === version.id}
                className="library-viewer-version flex h-11 shrink-0 cursor-pointer items-center gap-2 rounded-sm py-1 pr-3 pl-1 text-left ui-focus"
                key={item.id}
                onClick={() => setSelectedId(item.id)}
                type="button"
              >
                <img
                  alt=""
                  className="h-9 rounded-xs bg-thumb-fallback object-contain"
                  src={videoSnapshotUrl(
                    item.outputUrl,
                    snapshotWidthFor((36 * w) / h, window.devicePixelRatio || 1),
                  )}
                  style={{ aspectRatio: `${w} / ${h}` }}
                />
                <span className="text-caption">
                  <b className="block font-medium">{item.label}</b>
                  <span className="library-viewer-faint block">
                    {formatRelativeTime(item.createdAt)}
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
      </section>

      <section
        aria-label="脚本与参数"
        className="flex min-h-0 w-full flex-col max-md:flex-none md:w-95 md:shrink-0 md:border-l md:border-hairline lg:w-105"
      >
        <header className="px-6 pt-4 max-md:px-4">
          {author === null ? null : (
            <button
              className="-ml-1 inline-flex max-w-full ui-state cursor-pointer items-center gap-2.5 rounded-full py-1 pr-3 pl-1 text-left ui-focus"
              onClick={() => onAuthor(author)}
              title={`只看 ${author} 的片子`}
              type="button"
            >
              <AuthorAvatar className="size-8 text-label" name={author} />
              <span className="min-w-0">
                <span className="block truncate text-body font-semibold">{author}</span>
                <span className="block text-caption text-on-surface-faint">
                  {formatRelativeTime(version.createdAt)}
                </span>
              </span>
            </button>
          )}
          <DialogTitle className="mt-3 text-title-lg font-semibold">{title}</DialogTitle>
          {tags.length === 0 ? null : (
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {tags.map((tag) => (
                <Tag key={tag}>{tag}</Tag>
              ))}
            </div>
          )}
          {detailError === null ? null : (
            <p className="mt-3 flex items-center gap-2 text-body-sm text-error" role="alert">
              {detailError}
              <Button onClick={onRetry} size="md" variant="ghost">
                重试
              </Button>
            </p>
          )}
        </header>

        <TabsRoot className="flex min-h-0 flex-1 flex-col max-md:flex-none" defaultValue="script">
          <TabsList
            aria-label="详情内容"
            className="mx-6 mt-3 h-10 shrink-0 gap-4 border-b border-hairline max-md:mx-4"
          >
            <TabsTrigger className="px-0 after:inset-x-0" value="script">
              脚本
            </TabsTrigger>
            <TabsTrigger className="px-0 after:inset-x-0" value="params">
              参数与来源
            </TabsTrigger>
          </TabsList>
          <TabsContent
            className="min-h-0 flex-1 overflow-y-auto px-6 pt-4 pb-6 max-md:overflow-visible max-md:px-4"
            value="script"
          >
            <LibraryScriptPanel
              currentTime={currentTime}
              onOpenSibling={onNavigate}
              onPreviewImage={setPreview}
              onSeek={seek}
              siblings={detail?.siblings}
              take={version.take}
            />
          </TabsContent>
          <TabsContent
            className="min-h-0 flex-1 overflow-y-auto px-6 pt-4 pb-6 max-md:overflow-visible max-md:px-4"
            value="params"
          >
            <LibraryParamsPanel
              showVersion={detail !== undefined}
              version={version}
              video={video}
            />
          </TabsContent>
        </TabsRoot>

        <footer className="flex shrink-0 items-center gap-2 border-t border-hairline bg-surface-container-lowest px-6 pt-3.5 pb-4.5 max-md:sticky max-md:bottom-0 max-md:px-4 max-md:pb-[calc(12px+env(safe-area-inset-bottom))]">
          <Button
            className="flex-1 rounded-full"
            leadingIcon={copied ? 'check' : 'copy'}
            onClick={() => void copy(version.take.prompt)}
            variant="inverted"
          >
            {copied ? '已复制' : '复制提示词'}
          </Button>
          <VideoDownload
            className="size-(--control-height-lg) rounded-full"
            url={version.outputUrl}
            watermarkUrl={version.watermarkOutputUrl}
          />
          <MoreMenu conversationId={video.conversationId} shareLink={shareLink} />
        </footer>
      </section>

      <MediaLightbox media={preview} onClose={() => setPreview(null)} />
    </>
  )
}

/** 复制链接人人都有；打开来源对话只给对话属主与管理员，其余人接口不给 conversationId，这里也就没有这一项。 */
function MoreMenu({
  conversationId,
  shareLink,
}: {
  conversationId: string | null
  shareLink: string
}) {
  const navigate = useNavigate()
  const copyLink = async () => {
    try {
      await copyText(shareLink)
      toast.success('已复制链接')
    } catch {
      toast.error('复制失败')
    }
  }
  return (
    <MenuRoot>
      <MenuTrigger asChild>
        <IconButton
          className="size-(--control-height-lg) rounded-full border-[0.5px] border-hairline text-on-surface"
          label="更多操作"
          name="more"
        />
      </MenuTrigger>
      <MenuSurface align="end" side="top">
        <MenuItem icon="copy" onSelect={() => void copyLink()}>
          复制链接
        </MenuItem>
        {conversationId === null ? null : (
          <MenuItem
            icon="external"
            onSelect={() => void navigate({ params: { conversationId }, to: '/c/$conversationId' })}
          >
            打开来源对话
          </MenuItem>
        )}
      </MenuSurface>
    </MenuRoot>
  )
}
