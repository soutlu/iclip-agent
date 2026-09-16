import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import type { PendingEdit } from './edit-chain'
import './editor-generation-status.css'

type EditorGenerationStatusProps = { edit: PendingEdit }
type StepState = 'completed' | 'current' | 'pending' | 'failed'

const STEPS = ['切片准备', '视频生成', '结果预览'] as const
const STEP_STATES: Record<StepState, string> = {
  completed: '已完成',
  current: '当前阶段',
  pending: '等待中',
  failed: '失败',
}

function describeProgress(edit: PendingEdit) {
  switch (edit.stage) {
    case 'cutting':
      return { step: 0, title: '正在准备参考片段' }
    case 'cut':
      return { step: 1, title: '准备提交视频生成' }
    case 'generating':
      return { step: 1, title: '正在生成视频' }
    case 'ready':
      return { step: 2, title: '待预览' }
    case 'composing':
      return { step: 2, title: '正在合成成片' }
    case 'failed': {
      const step =
        edit.master !== undefined && edit.master.status !== 'completed'
          ? 2
          : edit.video !== undefined
            ? 1
            : 0
      const title = ['参考片段准备失败', '视频生成失败', '成片合成失败'][step]
      return { step, title }
    }
  }
}

/** 展示真实编辑阶段；结果就绪后等待用户预览，不将生成完成视为已经合成。 */
export function EditorGenerationStatus({ edit }: EditorGenerationStatusProps) {
  const progress = describeProgress(edit)
  const failed = edit.stage === 'failed'
  const ready = edit.stage === 'ready'

  return (
    <div
      aria-label="视频编辑进度"
      aria-live="polite"
      className="video-editor-generation-status"
      data-state={failed ? 'failed' : ready ? 'ready' : 'running'}
      role="status"
    >
      <div className="video-editor-generation-status-header">
        <span className="video-editor-generation-status-version">{edit.label}</span>
        <Icon
          className={cn(!failed && !ready && 'animate-spin motion-reduce:animate-none')}
          decorative
          name={failed ? 'failed' : ready ? 'success' : 'loading'}
          size="sm"
        />
        <strong>{progress.title}</strong>
      </div>
      {failed && edit.error ? (
        <p className="video-editor-generation-status-detail">{edit.error}</p>
      ) : null}
      <ol aria-label="生成阶段" className="video-editor-generation-status-steps">
        {STEPS.map((label, index) => {
          const state: StepState =
            index < progress.step
              ? 'completed'
              : index > progress.step
                ? 'pending'
                : failed
                  ? 'failed'
                  : 'current'
          return (
            <li
              aria-current={index === progress.step ? 'step' : undefined}
              aria-label={`${label}，${STEP_STATES[state]}`}
              data-state={state}
              key={label}
            >
              <span className="video-editor-generation-status-step-mark">
                {state === 'completed' || state === 'failed' ? (
                  <Icon decorative name={state === 'completed' ? 'check' : 'close'} size="xs" />
                ) : null}
              </span>
              <span>{label}</span>
            </li>
          )
        })}
      </ol>
    </div>
  )
}
