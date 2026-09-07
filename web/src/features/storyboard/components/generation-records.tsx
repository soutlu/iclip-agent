/** 仅展示当前镜头组的视频生成记录。 */

import { Tooltip } from 'radix-ui'
import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon, type IconName } from '@/shared/icons'
import { formatDateTime } from '@/shared/lib/date-time'
import { fileNameOfUrl, videoSnapshotUrl } from '@/shared/lib/media-url'
import { cn } from '@/shared/lib/utils'
import { Button, IconButton } from '@/shared/ui/button'
import { MediaLightbox } from '@/shared/ui/media-lightbox'
import { toast } from '@/shared/ui/toast'
import { isRunningStatus } from '../shots'
import type { GenerationJob } from '../storyboard.api'

type JobPhase = 'running' | 'done' | 'failed'

const PHASE: Record<JobPhase, { icon: IconName; text: string; className: string; spin: string }> = {
  done: { className: 'text-chat-status-success', icon: 'success', spin: '', text: '生成完成' },
  failed: { className: 'text-chat-status-error', icon: 'failed', spin: '', text: '生成失败' },
  running: {
    className: 'text-chat-status-running',
    icon: 'loading',
    spin: 'animate-spin',
    text: '生成中…',
  },
}

const phaseOf = (job: GenerationJob): JobPhase => {
  if (job.status === 'completed') return 'done'
  return isRunningStatus(job.status) ? 'running' : 'failed'
}

/** request 是不透明 JSON，仅展示字符串 prompt。 */
const promptOf = (job: GenerationJob): string | undefined => {
  const prompt = job.request['prompt']
  return typeof prompt === 'string' ? prompt : undefined
}

const newestFirst = (left: GenerationJob, right: GenerationJob) =>
  right.createdAt.localeCompare(left.createdAt)

type GenerationRecordsProps = {
  shotIndex: number
  jobs: readonly GenerationJob[]
  onClose: () => void
  onEditPrompt: (prompt: string) => void
}

export function GenerationRecords({
  jobs,
  onClose,
  onEditPrompt,
  shotIndex,
}: GenerationRecordsProps) {
  const listed = jobs
    .filter((job) => job.kind === 'video' && job.shotIndex === shotIndex)
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
  onEditPrompt: (prompt: string) => void
}

function RecordCard({ job, onEditPrompt }: RecordCardProps) {
  const [open, setOpen] = useState(true)
  const phase = phaseOf(job)
  const prompt = promptOf(job)

  return (
    <article className="flex shrink-0 flex-col gap-2.5 overflow-hidden rounded-sm border-[0.5px] border-chat-hairline bg-surface p-3">
      <div className="flex items-center gap-2">
        <span
          className={cn('flex shrink-0 items-center gap-1.5 text-body-sm', PHASE[phase].className)}
        >
          <Icon className={PHASE[phase].spin} decorative name={PHASE[phase].icon} size="md" />
          {PHASE[phase].text}
        </span>
        <span className="flex-1" />
        <time className="min-w-0 text-caption text-on-surface-muted" dateTime={job.createdAt}>
          {formatDateTime(job.createdAt)}
        </time>
        {phase === 'done' && job.outputUrl !== null ? <RecordDownload url={job.outputUrl} /> : null}
        <IconButton
          aria-expanded={open}
          className="text-on-surface"
          label={open ? '收起这条记录' : '展开这条记录'}
          name={open ? 'collapse' : 'expand'}
          onClick={() => setOpen(!open)}
          size="xs"
        />
      </div>

      {phase === 'done' && job.outputUrl !== null ? (
        <RecordVideo key={job.outputUrl} url={job.outputUrl} />
      ) : null}

      {open ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-label text-on-surface-muted">视频描述</p>
          {prompt === undefined ? null : (
            <p className="line-clamp-3 text-body-sm text-on-surface">{prompt}</p>
          )}
          {phase === 'failed' && job.errorMessage !== null ? (
            <p className="text-body-sm text-error">{job.errorMessage}</p>
          ) : null}
        </div>
      ) : null}

      {/* 后端仅提供状态，使用不定进度指示。 */}
      {phase === 'running' ? (
        <div className="h-1 overflow-hidden rounded-full bg-surface-container-high">
          <div className="h-full w-1/3 animate-pulse rounded-full bg-on-surface-faint/48" />
        </div>
      ) : null}

      {open ? (
        <Button
          className="w-full border-[0.5px] border-chat-hairline bg-primary/4 text-primary"
          disabled={prompt === undefined || prompt.trim() === ''}
          leadingIcon="edit"
          onClick={() => {
            if (prompt !== undefined) onEditPrompt(prompt)
          }}
          size="md"
          variant="ghost"
        >
          编辑生成
        </Button>
      ) : null}
    </article>
  )
}

function RecordDownload({ url }: { url: string }) {
  const activeRef = useRef(false)
  const [downloading, setDownloading] = useState(false)
  const label = downloading ? '正在准备下载…' : '下载视频'

  const download = async () => {
    if (activeRef.current) return
    activeRef.current = true
    setDownloading(true)
    try {
      const response = await fetch(url)
      if (!response.ok) throw new Error(`Download failed: ${response.status}`)
      const blob = await response.blob()
      if (blob.size === 0) throw new Error('Empty download')
      const filename = fileNameOfUrl(url) || '生成的视频'
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

  return (
    <Tooltip.Provider delayDuration={300}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <IconButton
            aria-busy={downloading}
            className={cn(
              'shrink-0 border-[0.5px] border-chat-hairline text-on-surface disabled:cursor-wait disabled:opacity-60',
              downloading && '[&_svg]:animate-spin',
            )}
            disabled={downloading}
            label={label}
            name={downloading ? 'loading' : 'download'}
            onClick={() => void download()}
            size="sm"
          />
        </Tooltip.Trigger>
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
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const [viewing, setViewing] = useState(false)
  const poster = videoSnapshotUrl(url, 640)

  return (
    <>
      <button
        aria-label="播放视频"
        className="relative grid aspect-[2/1] w-full cursor-pointer place-items-center overflow-hidden rounded-sm bg-surface-container ui-focus"
        onClick={() => setViewing(true)}
        ref={triggerRef}
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
      {viewing
        ? // 与对话附件使用同一个播放器；挂到 body，避免被记录抽屉的动画与裁剪限制。
          createPortal(
            <MediaLightbox
              media={{ kind: 'video', name: '生成的视频', url }}
              onClose={() => {
                setViewing(false)
                triggerRef.current?.focus()
              }}
            />,
            document.body,
          )
        : null}
    </>
  )
}
