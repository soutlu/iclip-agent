import { Link } from '@tanstack/react-router'
import { useCallback, useState } from 'react'
import { Icon } from '@/shared/icons'
import { Button } from '@/shared/ui/button'
import {
  DialogBody,
  DialogDescription,
  DialogHeader,
  DialogRoot,
  DialogSurface,
} from '@/shared/ui/dialog'
import { toast } from '@/shared/ui/toast'
import { EditorComposer } from './editor-composer'
import { durationOf, type EditorVersion, type VideoEdit } from './editor-model'
import { EditorPreview } from './editor-preview'
import { useEditorSession, type EditorTask } from './editor-session'
import { loadEditorSource, type EditorSource } from './editor-source'
import { EditorTimeline } from './editor-timeline'
import './video-editor.css'

const DEMO_SOURCE: EditorSource = {
  jobId: 'demo',
  title: 'SBWA26010M',
  videoUrl: '/images/video-editor-demo.mp4',
  posterUrl: '/images/video-editor-demo.webp',
  returnTo: '/',
}
const STAGE_LABEL: Record<EditorTask['stage'], string> = {
  queued: '排队中',
  generating: '生成中',
  processing: '结果处理中',
  ready: '待预览',
  failed: '失败',
  cancelled: '已取消',
}
const isActive = (task: EditorTask) => ['queued', 'generating', 'processing'].includes(task.stage)

export function VideoEditorPage({ jobId }: { jobId: string }) {
  return <LoadEditor jobId={jobId} key={jobId} />
}
function LoadEditor({ jobId }: { jobId: string }) {
  const [loaded] = useState(() => {
    try {
      return { source: jobId === 'demo' ? DEMO_SOURCE : loadEditorSource(jobId), error: '' }
    } catch {
      return { source: undefined, error: '无法读取本地编辑记录，请从生成记录重新打开。' }
    }
  })
  if (!loaded.source)
    return (
      <main className="ve-empty">
        <Icon decorative name="video" size="xl" />
        <h1>请从生成记录打开视频</h1>
        <p>{loaded.error || '当前浏览器中没有这条视频的编辑来源。'}</p>
        <Link className="ve-text-button" to="/">
          返回首页
        </Link>
        <Link className="ve-text-button" to="/video-editor/$jobId" params={{ jobId: 'demo' }}>
          查看 UI 演示
        </Link>
      </main>
    )
  return <EditorWorkspace source={loaded.source} />
}
function EditorWorkspace({ source }: { source: EditorSource }) {
  const { session, patch, initialize, submit, cancel, adopt } = useEditorSession(source.jobId)
  const [posterUrl, setPosterUrl] = useState(source.posterUrl)
  const [currentTime, setCurrentTime] = useState(source.jobId === 'demo' ? 13.5 : 0)
  const [kind, setKind] = useState<VideoEdit['kind']>('modify')
  const [extension, setExtension] = useState(2)
  const [historyOpen, setHistoryOpen] = useState(false)
  const selected = session.versions.find((version) => version.id === session.selectedId)
  const duration = selected ? durationOf(selected) : 0
  const activeTask = session.tasks.find(isActive)
  const latestTask = activeTask ?? session.tasks.at(-1)
  const seek = useCallback((time: number) => setCurrentTime(time), [])
  const selectVersion = (id: string) => {
    const version = session.versions.find((item) => item.id === id)
    if (!version) return
    const total = durationOf(version)
    patch({
      selectedId: id,
      selection: {
        start: Math.min(session.selection.start, Math.max(0, total - 0.04)),
        end: Math.min(session.selection.end, total),
      },
    })
    setCurrentTime(Math.min(currentTime, total))
  }
  const chooseRange = (range: { start: number; end: number }) => {
    patch({ selection: range })
  }
  const changeBoundary = (boundary: 'start' | 'end', value: number) => {
    if (!Number.isFinite(value)) return
    const start =
      boundary === 'start'
        ? Math.max(0, Math.min(value, session.selection.end - 0.04))
        : session.selection.start
    const end =
      boundary === 'end' ? Math.min(duration, Math.max(value, start + 0.04)) : session.selection.end
    chooseRange({ start, end })
  }
  const canGenerate =
    selected !== undefined &&
    session.prompt.trim().length > 0 &&
    session.model !== '' &&
    !activeTask &&
    session.selection.end > session.selection.start
  const generate = () => {
    if (!canGenerate || !selected) return
    try {
      submit(selected, kind, extension)
      toast.success('模拟任务已创建')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '无法创建模拟任务')
    }
  }
  const returnTo =
    source.returnTo.startsWith('/') && !source.returnTo.startsWith('//') ? source.returnTo : '/'
  return (
    <main className="video-editor" aria-label="视频编辑器">
      <header className="ve-header">
        <Link className="ve-brand" to="/" aria-label="Cue 首页">
          Cue
        </Link>
        <span className="ve-project-title" title={source.title}>
          {source.title}
        </span>
        <button className="ve-demo-label" type="button" onClick={() => setHistoryOpen(true)}>
          UI 演示
        </button>
        <Link className="ve-return ve-text-button" to={returnTo}>
          <Icon decorative name="back" size="sm" />
          返回
        </Link>
      </header>
      <div className="ve-workspace">
        <EditorPreview
          videoUrl={source.videoUrl}
          posterUrl={posterUrl}
          version={selected}
          currentTime={currentTime}
          onSeek={seek}
          onDuration={initialize}
          onPoster={setPosterUrl}
        />
        <section className="ve-inspector" aria-label="编辑选段">
          <div className="ve-inspector-heading">
            <h1>编辑</h1>
            <div className="ve-edit-modes" role="group" aria-label="编辑方式">
              <button
                type="button"
                aria-pressed={kind === 'modify'}
                onClick={() => setKind('modify')}
              >
                修改
              </button>
              <button
                type="button"
                aria-pressed={kind === 'extend'}
                onClick={() => setKind('extend')}
              >
                延长
              </button>
            </div>
          </div>
          <div className="ve-range">
            <Icon decorative name="duration" size="sm" />
            <label className="sr-only" htmlFor="video-range-start">
              开始时间（秒）
            </label>
            <input
              id="video-range-start"
              aria-label="开始时间（秒）"
              type="number"
              min={0}
              max={duration}
              step={0.04}
              value={Number(session.selection.start.toFixed(2))}
              disabled={!duration}
              onChange={(event) => changeBoundary('start', event.currentTarget.valueAsNumber)}
            />
            <Icon decorative name="next" size="sm" />
            <label className="sr-only" htmlFor="video-range-end">
              结束时间（秒）
            </label>
            <input
              id="video-range-end"
              aria-label="结束时间（秒）"
              type="number"
              min={0}
              max={duration}
              step={0.04}
              value={Number(session.selection.end.toFixed(2))}
              disabled={!duration}
              onChange={(event) => changeBoundary('end', event.currentTarget.valueAsNumber)}
            />
            <span>{Math.max(0, session.selection.end - session.selection.start).toFixed(1)}s</span>
          </div>
          {kind === 'extend' ? (
            <label className="ve-extension">
              在选段末尾延长{' '}
              <select
                aria-label="延长时长"
                value={extension}
                onChange={(event) => setExtension(Number(event.currentTarget.value))}
              >
                {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((seconds) => (
                  <option key={seconds} value={seconds}>
                    +{seconds}s
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <EditorComposer
            prompt={session.prompt}
            onPromptChange={(prompt) => patch({ prompt })}
            references={session.references}
            onReferencesChange={(references) => patch({ references })}
            footer={
              <div className="ve-generation-controls">
                {' '}
                <span className="ve-model-picker">
                  <select
                    className="ve-model"
                    aria-label="编辑模型"
                    value={session.model}
                    onChange={(event) => patch({ model: event.currentTarget.value })}
                  >
                    <option value="" disabled>
                      选择模型
                    </option>
                    <option value="demo">演示模型</option>
                    <option value="demo-failure">演示模型 · 失败场景</option>
                  </select>
                  <Icon decorative name="expand" size="sm" />
                </span>
                <Button
                  trailingIcon="send-up"
                  className="ve-generate"
                  disabled={!canGenerate}
                  onClick={generate}
                >
                  {activeTask ? '生成中…' : '生成'}
                </Button>
              </div>
            }
          />
          {latestTask ? (
            <button
              className="ve-task-summary"
              type="button"
              onClick={() => setHistoryOpen(true)}
              aria-live="polite"
            >
              <Icon
                decorative
                name={activeTask ? 'loading' : latestTask.stage === 'failed' ? 'failed' : 'check'}
                className={activeTask ? 'animate-spin' : ''}
                size="sm"
              />
              {latestTask.version.label} ·{' '}
              {latestTask.adopted ? '已采用' : STAGE_LABEL[latestTask.stage]}
              <Icon decorative name="next" size="sm" />
            </button>
          ) : null}
        </section>
      </div>
      {selected ? (
        <EditorTimeline
          version={selected}
          versions={session.versions}
          posterUrl={posterUrl}
          currentTime={currentTime}
          selection={session.selection}
          onSeek={seek}
          onSelectionChange={chooseRange}
          onVersionChange={selectVersion}
          onHistory={() => setHistoryOpen(true)}
        />
      ) : (
        <div className="ve-timeline-loading" role="status">
          加载原视频后即可选择片段
        </div>
      )}
      <EditorHistory
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        tasks={session.tasks}
        versions={session.versions}
        selectedId={session.selectedId}
        adoptedId={session.adoptedId}
        onSelect={(id) => {
          selectVersion(id)
          setHistoryOpen(false)
        }}
        onCancel={cancel}
        onAdopt={(id) => {
          selectVersion(id)
          adopt(id)
          setHistoryOpen(false)
          toast.success('已在本地采用此版本，原片保留')
        }}
      />
    </main>
  )
}
type HistoryProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  tasks: readonly EditorTask[]
  versions: readonly EditorVersion[]
  selectedId: string
  adoptedId: string
  onSelect: (id: string) => void
  onAdopt: (id: string) => void
  onCancel: (id: string) => void
}
function EditorHistory({
  open,
  onOpenChange,
  tasks,
  versions,
  selectedId,
  adoptedId,
  onSelect,
  onAdopt,
  onCancel,
}: HistoryProps) {
  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogSurface className="ve-history" aria-describedby="video-demo-description">
        <DialogHeader title="版本与任务" closeLabel="关闭版本与任务" />
        <DialogBody>
          <DialogDescription id="video-demo-description" className="ve-simulation-note">
            本地 UI
            演示：未调用模型或上传图片，候选画面沿用原片。版本与任务在本次页面会话中保留，刷新后重置。
          </DialogDescription>
          <h2 className="ve-section-label">版本</h2>
          {versions.map((version) => (
            <div className="ve-history-version" key={version.id}>
              <button
                className="ve-version-link"
                type="button"
                onClick={() => onSelect(version.id)}
                aria-current={selectedId === version.id ? 'true' : undefined}
              >
                <Icon decorative name="video" size="sm" />
                {version.label}
                <span>
                  {version.parentId
                    ? `基于 ${versions.find((item) => item.id === version.parentId)?.label ?? '原片'}`
                    : '原始视频'}
                </span>
              </button>
              {adoptedId === version.id ? (
                <span className="ve-adopted">已采用</span>
              ) : (
                <Button size="md" variant="ghost" onClick={() => onAdopt(version.id)}>
                  采用
                </Button>
              )}
            </div>
          ))}
          <h2 className="ve-section-label">生成任务</h2>
          {tasks.length === 0 ? (
            <p className="ve-muted">暂无任务。填写修改要求并选择演示模型后生成。</p>
          ) : (
            [...tasks].reverse().map((task) => (
              <details className="ve-task" key={task.id} open={isActive(task)}>
                <summary>
                  <span>{task.version.label}</span>
                  <span className={task.stage === 'failed' ? 'text-error' : ''}>
                    {task.adopted ? '已采用' : STAGE_LABEL[task.stage]}
                  </span>
                </summary>
                <div className="ve-task-details">
                  <ol className="ve-task-stages" aria-label={`${task.version.label} 生成进度`}>
                    {(['queued', 'generating', 'processing', 'ready'] as const).map(
                      (stage, index) => (
                        <li key={stage} data-active={task.stage === stage}>
                          <Icon
                            decorative
                            name={
                              task.stage === stage && isActive(task)
                                ? 'loading'
                                : ['queued', 'generating', 'processing', 'ready'].indexOf(
                                      task.stage,
                                    ) > index || task.stage === 'ready'
                                  ? 'check'
                                  : 'ellipse'
                            }
                            size="sm"
                          />
                          {STAGE_LABEL[stage]}
                        </li>
                      ),
                    )}
                  </ol>
                  <p className="ve-muted">
                    {task.edit.kind === 'extend'
                      ? `延长 +${task.edit.extension ?? 2}s`
                      : `修改 ${task.edit.start.toFixed(2)}–${task.edit.end.toFixed(2)}s`}{' '}
                    · 基于 {versions.find((version) => version.id === task.version.parentId)?.label}
                  </p>
                  <p>{task.edit.prompt}</p>
                  {task.references.length ? (
                    <div className="ve-task-references">
                      {task.references.map((ref) => (
                        <img src={ref.url} alt={ref.name} key={ref.id} />
                      ))}
                    </div>
                  ) : null}
                  {task.stage === 'failed' ? (
                    <p className="text-error">
                      模拟生成失败。修改要求或模型后可重新提交；原片和已有版本均保留。
                    </p>
                  ) : null}
                  <div className="ve-task-actions">
                    {isActive(task) ? (
                      <Button size="md" variant="ghost" onClick={() => onCancel(task.id)}>
                        取消模拟任务
                      </Button>
                    ) : null}
                    {task.stage === 'ready' ? (
                      <>
                        <Button size="md" variant="ghost" onClick={() => onSelect(task.version.id)}>
                          预览
                        </Button>
                        <Button
                          size="md"
                          disabled={task.adopted}
                          onClick={() => onAdopt(task.version.id)}
                        >
                          {task.adopted ? '已采用' : '采用新版本'}
                        </Button>
                      </>
                    ) : null}
                  </div>
                </div>
              </details>
            ))
          )}
        </DialogBody>
      </DialogSurface>
    </DialogRoot>
  )
}
