import type { StoryboardAgentRun } from '@/features/storyboards/runtime/storyboard-agent'
import StoryboardIcon from '@/features/storyboards/components/storyboard-icon'

type StoryboardAgentMonitorProps = {
  expanded: boolean
  nowMs: number
  onClose: () => void
  onToggleExpanded: () => void
  run: StoryboardAgentRun
}

/**
 * 把秒数格式化为监控条使用的时码。
 *
 * @param totalSeconds - 总秒数。
 * @returns 形如 “00:26” 的时码。
 */
const formatAgentRunClock = (totalSeconds: number) => {
  const floored = Math.max(0, Math.floor(totalSeconds))
  const minutes = Math.floor(floored / 60)
  const seconds = String(floored % 60).padStart(2, '0')
  return `${String(minutes).padStart(2, '0')}:${seconds}`
}

const runStatusLabel = (run: StoryboardAgentRun) => {
  if (run.phase === 'running') return 'Agent 运行中'
  if (run.phase === 'completed') return 'Agent 运行完成'
  return 'Agent 运行失败'
}

/**
 * 悬浮于时间线上方的真实 Agent 运行监控条。
 *
 * @param props - 当前运行、计时与浮条操作。
 * @returns 运行终态、流式输出和明确错误。
 */
export default function StoryboardAgentMonitor({
  expanded,
  nowMs,
  onClose,
  onToggleExpanded,
  run,
}: StoryboardAgentMonitorProps) {
  const elapsedSeconds = run.finalSeconds ?? Math.max(0, (nowMs - run.startedAtMs) / 1000)
  const live = run.phase === 'running'

  return (
    <section
      aria-label="Agent 运行状态"
      className="storyboards-monitor"
      data-expanded={expanded || undefined}
      data-live={live || undefined}
      data-phase={run.phase}
    >
      <div className="storyboards-monitor-drawer">
        <div className="storyboards-monitor-detail">
          <div className="storyboards-monitor-logs">
            <span className="storyboards-monitor-logs-head">
              {live ? 'STORYBOARD OUTPUT · LIVE' : 'STORYBOARD OUTPUT'}
            </span>
            <div className="storyboards-monitor-logbody">
              {run.output ? (
                <p className="storyboards-monitor-log storyboards-monitor-output">{run.output}</p>
              ) : null}
              {run.errorMessage ? (
                <p
                  className="storyboards-monitor-log storyboards-monitor-error"
                  data-tone="warn"
                  role="alert"
                >
                  {run.errorMessage}
                </p>
              ) : null}
              {!run.output && !run.errorMessage ? (
                <p className="storyboards-monitor-log">等待 Agent 返回内容…</p>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      <div className="storyboards-monitor-bar">
        <div className="storyboards-monitor-status">
          <span className="storyboards-monitor-status-dot" aria-hidden="true" />
          <span data-testid="storyboard-agent-status-text">{runStatusLabel(run)}</span>
        </div>

        <div className="storyboards-monitor-meta">
          <span className="storyboards-monitor-time">{formatAgentRunClock(elapsedSeconds)}</span>
          <span className="storyboards-monitor-prog" data-phase={run.phase} aria-hidden="true">
            <i />
          </span>
          <button
            aria-expanded={expanded}
            aria-label={expanded ? '收起运行详情' : '展开运行详情'}
            className="storyboards-monitor-toggle"
            onClick={onToggleExpanded}
            type="button"
          >
            {expanded ? '收起' : '展开'}
            <StoryboardIcon name="chevron-down" size={12} title={expanded ? '收起' : '展开'} />
          </button>
          <button
            aria-label="关闭运行监控"
            className="storyboards-monitor-close"
            onClick={onClose}
            type="button"
          >
            <StoryboardIcon name="close" size={13} title="关闭运行监控" />
          </button>
        </div>
      </div>
    </section>
  )
}

type StoryboardAgentSummaryProps = {
  onDismiss: () => void
  onOpen: () => void
  run: StoryboardAgentRun
}

/**
 * 在时间线标题中显示已结束的真实执行记录摘要。
 *
 * @param props - 归档运行与查看操作。
 * @returns 可重新打开监控详情的摘要行。
 */
export function StoryboardAgentSummary({ onDismiss, onOpen, run }: StoryboardAgentSummaryProps) {
  return (
    <div className="storyboards-agent-summary" aria-label="执行记录摘要" data-phase={run.phase}>
      <span className="storyboards-agent-summary-icon" aria-hidden="true">
        <StoryboardIcon
          name={run.phase === 'completed' ? 'check' : 'close'}
          size={9}
          title={run.phase === 'completed' ? '已完成' : '失败'}
        />
      </span>
      <span className="storyboards-agent-summary-text">
        执行记录 · {runStatusLabel(run)} · 总用时 {formatAgentRunClock(run.finalSeconds ?? 0)}
      </span>
      <button type="button" className="storyboards-agent-summary-open" onClick={onOpen}>
        查看详情
      </button>
      <button
        aria-label="关闭执行记录摘要"
        className="storyboards-agent-summary-close"
        onClick={onDismiss}
        type="button"
      >
        <StoryboardIcon name="close" size={12} title="关闭执行记录摘要" />
      </button>
    </div>
  )
}
