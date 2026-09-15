/** 仅展示当前镜头组的视频生成记录。 */

import { useLocation, useNavigate } from '@tanstack/react-router'
import { Tooltip } from 'radix-ui'
import { useRef, useState, type ReactNode } from 'react'
import { Icon } from '@/shared/icons'
import { formatDateTime } from '@/shared/lib/date-time'
import { fileNameOfUrl, videoSnapshotUrl } from '@/shared/lib/media-url'
import { cn } from '@/shared/lib/utils'
import { Button, IconButton } from '@/shared/ui/button'
import { MediaLightbox } from '@/shared/ui/media-lightbox'
import { MenuItem, MenuRoot, MenuSurface, MenuTrigger } from '@/shared/ui/menu'
import { StatusBadge } from '@/shared/ui/status-badge'
import { toast } from '@/shared/ui/toast'
import { readStoryboardMetadata } from '../generation-metadata'
import type { Shot } from '../shot-document'
import { phaseOfStatus } from '../shots'
import { historyShotOf, type GenerationJob } from '../storyboard.api'
import { saveEditorSource } from '../video-editor/editor-source'

/** request 是不透明 JSON，只从里面读两个字串来展示：prompt 与 model。 */
const promptOf = (job: GenerationJob): string | undefined => {
  const prompt = job.request['prompt']
  return typeof prompt === 'string' ? prompt : undefined
}

/** 历史请求用的模型名；缺失或空白视为没记。 */
const modelOf = (job: GenerationJob): string | undefined => {
  const model = job.request['model']
  const trimmed = typeof model === 'string' ? model.trim() : ''
  return trimmed === '' ? undefined : trimmed
}

const newestFirst = (left: GenerationJob, right: GenerationJob) =>
  right.createdAt.localeCompare(left.createdAt)

type GenerationRecordsProps = {
  shotIndex: number
  jobs: readonly GenerationJob[]
  onClose: () => void
  onEditPrompt?: ((prompt: Shot['prompt']) => void) | undefined
}

export function GenerationRecords({
  jobs,
  onClose,
  onEditPrompt,
  shotIndex,
}: GenerationRecordsProps) {
  const listed = jobs
    .filter((job) => job.kind === 'video' && readStoryboardMetadata(job)?.shot === shotIndex)
    .sort(newestFirst)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2.5 border-b-[0.5px] border-chat-hairline px-6 py-2.5">
        <Icon decorative name="history" size="md" />
        <h3 className="text-body font-medium text-on-surface">生成记录</h3>
        <span className="flex-1" />
        <IconButton label="关闭生成记录" name="close" onClick={onClose} size="sm" />
      </div>

      <h4 className="shrink-0 px-6 py-3 text-body-sm text-on-surface-muted">当前镜头组 · 视频</h4>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-6 pb-6">
        {listed.length === 0 ? (
          <div className="flex min-h-full flex-col items-center text-center">
            <div className="min-h-8 flex-[0.6]" />
            <img
              alt=""
              className="mb-3 h-30 w-36 shrink-0 object-contain mix-blend-multiply dark:mix-blend-screen dark:hue-rotate-180 dark:invert"
              height={120}
              src="/images/video-records-empty.png"
              width={144}
            />
            <h5 className="text-title font-semibold text-on-surface">暂无视频记录</h5>
            <p className="mt-3 text-body-sm leading-relaxed text-on-surface-muted">
              生成后，视频和使用过的提示词
              <br />
              会保存在这里。
            </p>
            <Button
              className="mt-6 min-w-32 shrink-0 text-body"
              leadingIcon="back"
              onClick={onClose}
              size="md"
            >
              返回分镜
            </Button>
            <div className="min-h-8 flex-[1.4]" />
          </div>
        ) : (
          listed.map((job) => <RecordCard job={job} key={job.id} onEditPrompt={onEditPrompt} />)
        )}
      </div>
    </div>
  )
}

type RecordCardProps = {
  job: GenerationJob
  onEditPrompt?: ((prompt: Shot['prompt']) => void) | undefined
}

function RecordCard({ job, onEditPrompt }: RecordCardProps) {
  const navigate = useNavigate()
  const location = useLocation()
  const [open, setOpen] = useState(true)
  const phase = phaseOfStatus(job.status)
  const prompt = promptOf(job)
  const model = modelOf(job)
  // 只有带结构化 shot 的记录能回填镜头组；接口调用方自己写的正文只能看。
  const history = historyShotOf(job)
  const canEditVideo = phase === 'completed' && Boolean(job.outputUrl?.trim())

  const openVideoEditor = async () => {
    if (!canEditVideo || job.outputUrl === null) return
    try {
      saveEditorSource({
        jobId: job.id,
        videoUrl: job.outputUrl,
        posterUrl: videoSnapshotUrl(job.outputUrl, 1280),
        title: prompt?.trim().slice(0, 32) || '生成的视频',
        returnTo: location.pathname + location.searchStr,
      })
      await navigate({ to: '/video-editor/$jobId', params: { jobId: job.id } })
    } catch {
      toast.error('无法打开视频编辑，请重试')
    }
  }

  return (
    <article className="flex shrink-0 flex-col gap-2.5 overflow-hidden rounded-sm border-[0.5px] border-chat-hairline bg-surface p-3">
      <div className="flex items-center gap-2">
        <StatusBadge appearance="label" kind="video" status={phase} />
        <span className="flex-1" />
        <time className="min-w-0 text-caption text-on-surface-muted" dateTime={job.createdAt}>
          {formatDateTime(job.createdAt)}
        </time>
        {phase === 'completed' && job.outputUrl !== null ? (
          <RecordDownload url={job.outputUrl} watermarkUrl={job.watermarkOutputUrl} />
        ) : null}
        <IconButton
          aria-expanded={open}
          className="text-on-surface"
          label={open ? '收起这条记录' : '展开这条记录'}
          name={open ? 'collapse' : 'expand'}
          onClick={() => setOpen(!open)}
          size="xs"
        />
      </div>

      {phase === 'completed' && job.outputUrl !== null ? (
        <RecordVideo key={job.outputUrl} url={job.outputUrl} />
      ) : null}

      {open ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex min-w-0 items-center justify-between gap-3 text-label text-on-surface-muted">
            <p className="shrink-0">视频描述</p>
            <span className="min-w-0 truncate text-right" title={model}>
              模型 · {model ?? '未记录'}
            </span>
          </div>
          {prompt === undefined ? null : (
            <p className="line-clamp-3 text-body-sm text-on-surface">{prompt}</p>
          )}
          {phase === 'failed' && job.errorMessage !== null ? (
            <p className="text-body-sm text-error">{job.errorMessage}</p>
          ) : null}
        </div>
      ) : null}

      {/* 后端仅提供状态，使用不定进度指示。 */}
      {phase === 'queued' || phase === 'running' ? (
        <div className="h-1 overflow-hidden rounded-full bg-surface-container-high">
          <div className="h-full w-1/3 animate-pulse rounded-full bg-on-surface-faint/48" />
        </div>
      ) : null}

      {open && (onEditPrompt !== undefined || canEditVideo) ? (
        <div className="flex items-center gap-2">
          {onEditPrompt !== undefined ? (
            <Button
              className="min-w-0 flex-1 border-[0.5px] border-chat-hairline bg-surface-container-low text-primary"
              disabled={history === undefined}
              leadingIcon="edit"
              onClick={() => {
                if (history !== undefined) onEditPrompt(history)
              }}
              size="md"
              variant="ghost"
            >
              编辑生成
            </Button>
          ) : null}
          {canEditVideo ? (
            <Button
              className="min-w-0 flex-1 shadow-none"
              onClick={() => void openVideoEditor()}
              size="md"
              trailingIcon="next"
            >
              编辑视频
            </Button>
          ) : null}
        </div>
      ) : null}
    </article>
  )
}

type RecordDownloadProps = { url: string; watermarkUrl: string | null }

/** 只有原片时点了就下；上游也给了水印版时先选哪一份。两份共用一个忙碌态，下载中不接第二次点击。 */
function RecordDownload({ url, watermarkUrl }: RecordDownloadProps) {
  const activeRef = useRef(false)
  const [downloading, setDownloading] = useState(false)
  const label = downloading ? '正在准备下载…' : '下载视频'

  const download = async (target: string, fallbackName: string) => {
    if (activeRef.current) return
    activeRef.current = true
    setDownloading(true)
    try {
      const response = await fetch(target)
      if (!response.ok) throw new Error(`Download failed: ${response.status}`)
      const blob = await response.blob()
      if (blob.size === 0) throw new Error('Empty download')
      const filename = fileNameOfUrl(target) || fallbackName
      const objectUrl = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      try {
        anchor.href = objectUrl
        anchor.download = filename
        document.body.append(anchor)
        anchor.click()
      } finally {
        anchor.remove()
        // 给浏览器接管下载留出时间，再释放大文件的临时 URL。
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000)
      }
    } catch {
      toast.error('视频下载失败，请重试')
    } finally {
      activeRef.current = false
      setDownloading(false)
    }
  }

  const trigger = (
    <IconButton
      aria-busy={downloading}
      className={cn(
        'shrink-0 border-[0.5px] border-chat-hairline text-on-surface disabled:cursor-wait disabled:opacity-60',
        downloading && '[&_svg]:animate-spin',
      )}
      disabled={downloading}
      label={label}
      name={downloading ? 'loading' : 'download'}
      onClick={watermarkUrl === null ? () => void download(url, '生成的视频') : undefined}
      size="sm"
    />
  )
  if (watermarkUrl === null) return <DownloadTooltip label={label}>{trigger}</DownloadTooltip>
  return (
    <MenuRoot>
      <DownloadTooltip label={label}>
        <MenuTrigger asChild>{trigger}</MenuTrigger>
      </DownloadTooltip>
      <MenuSurface align="end">
        <MenuItem onSelect={() => void download(url, '生成的视频')}>下载原片</MenuItem>
        <MenuItem onSelect={() => void download(watermarkUrl, '生成的视频（水印版）')}>
          下载水印版
        </MenuItem>
      </MenuSurface>
    </MenuRoot>
  )
}

function DownloadTooltip({ children, label }: { children: ReactNode; label: string }) {
  return (
    <Tooltip.Provider delayDuration={300}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            className="layer-popup rounded-sm bg-inverse-surface px-3 py-2 text-label text-inverse-on-surface shadow-[var(--shadow-1)]"
            sideOffset={6}
          >
            {label}
            <Tooltip.Arrow className="fill-inverse-surface" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  )
}

function RecordVideo({ url }: { url: string }) {
  const [viewing, setViewing] = useState(false)
  const poster = videoSnapshotUrl(url, 640)

  return (
    <>
      <button
        aria-label="播放视频"
        className="relative grid aspect-[2/1] w-full cursor-pointer place-items-center overflow-hidden rounded-sm bg-surface-container ui-focus"
        onClick={() => setViewing(true)}
        type="button"
      >
        {poster === undefined ? null : (
          <img
            alt="生成的视频封面"
            className="absolute size-full object-contain"
            loading="lazy"
            src={poster}
          />
        )}
        <span className="relative grid size-9 place-items-center rounded-full bg-scrim/48 text-on-scrim">
          <Icon className="fill-current" decorative name="play" size="md" />
        </span>
      </button>
      <MediaLightbox
        media={viewing ? { kind: 'video', name: '生成的视频', url } : null}
        onClose={() => setViewing(false)}
      />
    </>
  )
}
