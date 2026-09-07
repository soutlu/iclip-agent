/** 仅展示当前镜头组的视频生成记录。 */

import { useRef, useState } from 'react'
import { Icon, type IconName } from '@/shared/icons'
import { formatDateTime } from '@/shared/lib/date-time'
import { videoSnapshotUrl } from '@/shared/lib/media-url'
import { cn } from '@/shared/lib/utils'
import { Button, IconButton } from '@/shared/ui/button'
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
      <div className="flex shrink-0 items-center gap-2 px-5 py-4">
        <Icon decorative name="history" size="sm" />
        <h3 className="text-body-sm font-medium text-on-surface">生成记录</h3>
        <span className="flex-1" />
        <IconButton label="关闭生成记录" name="close" onClick={onClose} size="sm" />
      </div>

      <div className="shrink-0 px-5 pt-3">
        <div className="border-b-[0.5px] border-chat-hairline">
          <div className="inline-flex items-center gap-1.5 border-b-2 border-on-surface pb-2">
            <h4 className="text-body-sm font-medium text-on-surface">视频生成记录</h4>
            <span className="rounded-full bg-on-surface px-1 text-caption text-surface">
              {listed.length}
            </span>
          </div>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-5 pt-3.5 pb-5">
        {listed.length === 0 ? (
          <p className="py-6 text-center text-body-sm text-on-surface-faint">还没有生成记录</p>
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
    <article className="flex shrink-0 flex-col gap-3 overflow-hidden rounded-sm bg-surface-container-high p-3.5">
      <div className="flex items-center gap-2">
        <span className={cn('flex items-center gap-1.5 text-body-sm', PHASE[phase].className)}>
          <Icon className={PHASE[phase].spin} decorative name={PHASE[phase].icon} size="sm" />
          {PHASE[phase].text}
        </span>
        <span className="flex-1" />
        <span className="text-label text-on-surface-faint">{formatDateTime(job.createdAt)}</span>
        <IconButton
          aria-expanded={open}
          className="rounded-xs bg-surface-container text-on-surface"
          label={open ? '收起这条记录' : '展开这条记录'}
          name={open ? 'collapse' : 'expand'}
          onClick={() => setOpen(!open)}
          size="sm"
        />
      </div>

      {/* 后端仅提供状态，使用不定进度指示。 */}
      {phase === 'running' ? (
        <div className="h-1 overflow-hidden rounded-full bg-surface-container-lowest">
          <div className="h-full w-1/3 animate-pulse rounded-full bg-on-surface-faint" />
        </div>
      ) : null}

      {open ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-label text-on-surface-faint">视频描述</p>
          {prompt === undefined ? null : (
            <p className="line-clamp-3 text-body-sm text-on-surface">{prompt}</p>
          )}
          {phase === 'failed' && job.errorMessage !== null ? (
            <p className="text-body-sm text-error">{job.errorMessage}</p>
          ) : null}
        </div>
      ) : null}

      {phase === 'done' && job.outputUrl !== null ? (
        <RecordVideo key={job.outputUrl} url={job.outputUrl} />
      ) : null}

      {open ? (
        <Button
          className="w-full rounded-xs bg-surface-container-lowest text-on-surface"
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

function RecordVideo({ url }: { url: string }) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [started, setStarted] = useState(false)

  const play = async () => {
    try {
      await videoRef.current?.play()
      setStarted(true)
    } catch {
      toast.error('视频暂时无法播放')
    }
  }

  return (
    <div className="relative overflow-hidden rounded-xs bg-surface-container-lowest">
      <video
        aria-label="生成的视频"
        className="aspect-video w-full object-contain"
        controls={started}
        playsInline
        poster={videoSnapshotUrl(url, 640)}
        preload="metadata"
        ref={videoRef}
        src={url}
      >
        <track kind="captions" />
      </video>
      {started ? null : (
        <button
          aria-label="播放视频"
          className="absolute inset-0 grid cursor-pointer place-items-center ui-focus"
          onClick={() => void play()}
          type="button"
        >
          <span className="grid size-9 place-items-center rounded-full bg-scrim/48 text-on-scrim">
            <Icon decorative name="play" size="md" />
          </span>
        </button>
      )}
    </div>
  )
}
