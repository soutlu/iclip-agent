/** 视频记录按 shotIndex 筛选；图片任务无组归属，各组共用会话级记录。 */

import { useState } from 'react'
import { Icon, type IconName } from '@/shared/icons'
import { formatDateTime } from '@/shared/lib/date-time'
import { cn } from '@/shared/lib/utils'
import { IconButton } from '@/shared/ui/button'
import { ChipGroup, FilterChip } from '@/shared/ui/chip'
import { isRunningStatus } from '../shots'
import type { GenerationJob } from '../storyboard.api'

const TABS = {
  image: { label: '分镜生成记录', promptLabel: '分镜描述' },
  video: { label: '视频生成记录', promptLabel: '视频描述' },
} as const

type TabKey = keyof typeof TABS

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
}

export function GenerationRecords({ jobs, onClose, shotIndex }: GenerationRecordsProps) {
  const [tab, setTab] = useState<TabKey>('video')

  const byTab = {
    image: jobs.filter((job) => job.kind === 'image').sort(newestFirst),
    video: jobs
      .filter((job) => job.kind === 'video' && job.shotIndex === shotIndex)
      .sort(newestFirst),
  }
  const listed = byTab[tab]

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b-[0.5px] border-chat-hairline px-4 py-3">
        <h3 className="text-body font-medium text-on-surface">生成记录</h3>
        <span className="flex-1" />
        <IconButton label="关闭生成记录" name="close" onClick={onClose} size="sm" />
      </div>

      <ChipGroup
        aria-label="记录类型"
        className="shrink-0 px-4 py-3"
        // 忽略 Radix 再次点击当前项产生的空值，保持至少一个分类选中。
        onValueChange={(value) => {
          if (value === 'image' || value === 'video') setTab(value)
        }}
        type="single"
        value={tab}
      >
        {(['video', 'image'] as const).map((key) => (
          <FilterChip key={key} value={key}>
            {TABS[key].label} {byTab[key].length}
          </FilterChip>
        ))}
      </ChipGroup>

      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-4 pb-4">
        {listed.length === 0 ? (
          <p className="py-6 text-center text-body-sm text-on-surface-faint">还没有生成记录</p>
        ) : (
          listed.map((job) => (
            <RecordCard job={job} key={job.id} promptLabel={TABS[tab].promptLabel} />
          ))
        )}
      </div>
    </div>
  )
}

type RecordCardProps = {
  job: GenerationJob
  promptLabel: string
}

function RecordCard({ job, promptLabel }: RecordCardProps) {
  const [open, setOpen] = useState(true)
  const phase = phaseOf(job)
  const prompt = promptOf(job)

  return (
    <article className="shrink-0 overflow-hidden rounded-md border-[0.5px] border-chat-hairline bg-chat-card-bg">
      <div className="flex items-center gap-2 px-3 py-2">
        <span className={cn('flex items-center gap-1.5 text-body-sm', PHASE[phase].className)}>
          <Icon className={PHASE[phase].spin} decorative name={PHASE[phase].icon} size="sm" />
          {PHASE[phase].text}
        </span>
        <span className="flex-1" />
        <span className="text-label text-on-surface-faint">{formatDateTime(job.createdAt)}</span>
        <IconButton
          label={open ? '收起这条记录' : '展开这条记录'}
          name={open ? 'collapse' : 'expand'}
          onClick={() => setOpen(!open)}
          size="xs"
        />
      </div>

      {/* 后端仅提供状态，使用不定进度指示。 */}
      {phase === 'running' ? (
        <div className="h-0.5 w-full animate-pulse bg-chat-status-running" />
      ) : null}

      {open ? (
        <div className="flex flex-col gap-2 px-3 pt-1 pb-3">
          <p className="text-label text-on-surface-faint">{promptLabel}</p>
          {prompt === undefined ? null : (
            <p className="line-clamp-3 text-body-sm text-on-surface">{prompt}</p>
          )}
          {phase === 'failed' && job.errorMessage !== null ? (
            <p className="text-body-sm text-error">{job.errorMessage}</p>
          ) : null}
          {phase === 'done' && job.outputUrl !== null ? (
            job.kind === 'video' ? (
              <video className="w-full rounded-sm" controls src={job.outputUrl}>
                <track kind="captions" />
              </video>
            ) : (
              <img alt={prompt ?? '生成结果'} className="w-full rounded-sm" src={job.outputUrl} />
            )
          ) : null}
        </div>
      ) : null}
    </article>
  )
}
