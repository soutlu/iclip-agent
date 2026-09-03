/**
 * 生成记录抽屉的内容：两个 tab，一列卡片。
 *
 * 「视频生成记录」是本组名下的出片任务（`shotIndex` 对得上），「分镜生成记录」是这段对话里
 * agent 出帧的那些图片任务——它们没有组归属，所以每组看到的是同一份。
 */

import { useState } from 'react'
import { Icon, type IconName } from '@/shared/icons'
import { formatDateTime } from '@/shared/lib/date-time'
import { cn } from '@/shared/lib/utils'
import { IconButton } from '@/shared/ui/button'
import { ChipGroup, FilterChip } from '@/shared/ui/chip'
import type { GenerationJob } from '../storyboard.api'

const TABS = {
  image: { label: '分镜生成记录', promptLabel: '分镜描述' },
  video: { label: '视频生成记录', promptLabel: '视频描述' },
} as const

type TabKey = keyof typeof TABS

const IN_FLIGHT = new Set(['pending', 'submitting', 'submitted'])

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
  return IN_FLIGHT.has(job.status) ? 'running' : 'failed'
}

/** 任务发出去时那句 prompt。`request` 是一份不透明 JSON，只在确实是字符串时才画。 */
const promptOf = (job: GenerationJob): string | undefined => {
  const prompt = job.request['prompt']
  return typeof prompt === 'string' ? prompt : undefined
}

const newestFirst = (left: GenerationJob, right: GenerationJob) =>
  right.createdAt.localeCompare(left.createdAt)

type GenerationRecordsProps = {
  /** 第几组。视频记录按它筛。 */
  shotIndex: number
  jobs: readonly GenerationJob[]
  onClose: () => void
}

/**
 * 渲染生成记录。
 *
 * @param props - 组件属性。
 * @param props.shotIndex - 第几组。
 * @param props.jobs - 这段对话的全部生成任务。
 * @param props.onClose - 关掉抽屉。
 * @returns 生成记录列表。
 */
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
        // Radix 的单选组允许把当前项再点一次取消掉，空值会让列表整个消失，挡掉。
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

/**
 * 一条生成记录。
 *
 * @param props - 组件属性。
 * @param props.job - 这次生成。
 * @param props.promptLabel - 正文那行小标签。
 * @returns 记录卡。
 */
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

      {/* 进度取不到真实百分比（后端只给状态），所以画一条呼吸的整条，不假装知道进度 */}
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
