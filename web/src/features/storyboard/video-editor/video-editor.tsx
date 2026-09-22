/** 视频编辑器：切出选中的一段交给模型，预览拼好的整条，满意再合成成片（ADR-0028）。
 *
 * 编辑进行到哪一步不存在本地：每次渲染都从生成记录按 editId 分组推出来，关掉重开、刷新都还在。
 * 唯一留在内存里的是本次会话发起的编辑的草稿（要求、模型、参考图），参考片段切好那一刻要用它
 * 发编辑任务；刷新后草稿没了，那条切好的片段就不再展示，重新选一段就是。 */

import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useMediaDownload } from '@/shared/api/media-download'
import { Icon } from '@/shared/icons'
import { videoSnapshotUrl } from '@/shared/lib/media-url'
import { mintUuid } from '@/shared/lib/uuid'
import { Button } from '@/shared/ui/button'
import { DialogBody, DialogHeader, DialogRoot, DialogSurface } from '@/shared/ui/dialog'
import { InlineAlert } from '@/shared/ui/inline-alert'
import { MenuRadioGroup, MenuRadioItem, MenuRoot, MenuSurface, MenuTrigger } from '@/shared/ui/menu'
import { toast } from '@/shared/ui/toast'
import type { VideoEditMetadata } from '../generation-metadata'
import { useVideoModels, type GenerationJob } from '../storyboard.api'
import {
  actualEditStart,
  ancestorsOf,
  composeSegments,
  layoutSegments,
  projectEditChain,
  totalDuration,
  type ChainVersion,
  type EditStage,
  type PendingEdit,
  type PlaySegment,
} from './edit-chain'
import { EditorComposer, type EditorReference } from './editor-composer'
import { EditorGenerationStatus } from './editor-generation-status'
import { EditorPreview, type EditorPreviewHandle } from './editor-preview'
import { EditorTimeline } from './editor-timeline'
import type { VersionMenuEntry } from './editor-version-menu'
import { roundSeconds } from './time-label'
import { clampRange, MIN_RANGE_SECONDS, type TimeRange } from './time-range'
import { useMediaDurations } from './use-media-durations'
import { useStableValue } from './use-stable-value'
import {
  editableModels,
  submitMasterClip,
  submitReferenceClip,
  submitVideoEdit,
  useVideoEditChain,
  videoEditChainKey,
  videoEditConversationKey,
} from './video-editor.api'

const DEFAULT_RANGE_SECONDS = 4
const posterOf = (url: string) => videoSnapshotUrl(url, 320)

const STAGE_LABEL: Record<EditStage, string> = {
  cutting: '切片中',
  cut: '待生成',
  generating: '生成中',
  ready: '待预览',
  composing: '合成中',
  failed: '失败',
}
const isActive = (edit: PendingEdit) => edit.stage !== 'ready' && edit.stage !== 'failed'

type EditDraft = { prompt: string; model: string; references: EditorReference[] }

type Selected =
  | { kind: 'version'; key: string; label: string; version: ChainVersion }
  | { kind: 'pending'; key: string; label: string; edit: PendingEdit }

type Props = {
  conversationId: string
  /** 链的根：抽屉里那条完成的出片记录。列表里找不到它就只能提示。 */
  root: GenerationJob | undefined
  loading: boolean
  shotIndex: number | undefined
  onClose: () => void
}

export function VideoEditor({ conversationId, root, loading, shotIndex, onClose }: Props) {
  if (root === undefined || root.outputUrl === null) {
    return (
      <DialogRoot open onOpenChange={(open) => !open && onClose()}>
        <DialogSurface aria-describedby={undefined} className="max-w-md">
          <DialogHeader title="编辑视频" closeLabel="关闭视频编辑" />
          <DialogBody>
            <p className="text-body-sm text-on-surface-muted" role="status">
              {loading ? '正在读取视频记录…' : '找不到这条视频记录，关掉后从生成记录重新打开。'}
            </p>
          </DialogBody>
        </DialogSurface>
      </DialogRoot>
    )
  }
  return (
    <Editor
      conversationId={conversationId}
      key={root.id}
      onClose={onClose}
      root={root}
      shotIndex={shotIndex}
    />
  )
}

type EditorProps = {
  conversationId: string
  root: GenerationJob
  shotIndex: number | undefined
  onClose: () => void
}

function Editor({ conversationId, root, shotIndex, onClose }: EditorProps) {
  const queryClient = useQueryClient()
  const chainQuery = useVideoEditChain(conversationId, root.id)
  const modelsQuery = useVideoModels()
  const models = useMemo(() => editableModels(modelsQuery.data?.items ?? []), [modelsQuery.data])
  const chain = useMemo(
    () => projectEditChain(root, chainQuery.data?.items ?? []),
    [root, chainQuery.data],
  )
  const previewRef = useRef<EditorPreviewHandle>(null)
  const [selectedKey, setSelectedKey] = useState<string>()
  const [selection, setSelection] = useState<TimeRange | null>(null)
  const [currentTime, setCurrentTime] = useState(0)
  const [prompt, setPrompt] = useState('')
  const [references, setReferences] = useState<EditorReference[]>([])
  const [wantedModel, setWantedModel] = useState<string>()
  const [drafts, setDrafts] = useState<Readonly<Record<string, EditDraft>>>({})
  // 三段互斥的写操作加上传参考图；任一在跑时整个编辑器一起锁。
  const [operation, setOperation] = useState<'idle' | 'uploading' | 'cutting' | 'composing'>('idle')
  const [operationError, setOperationError] = useState<string | null>(null)
  // 参考片段切好就自动发编辑任务；一个 editId 只自动发一次，提交失败也不再自动重发（那会
  // 变成一渲染一次的重试风暴），用户重选一段就是重来。
  const submittedRef = useRef(new Set<string>())
  const { downloading, download } = useMediaDownload()
  const busy = operation !== 'idle'

  // 选过的模型不在允许表里（配置改了）就退回默认；默认模型不支持编辑就取第一个支持的。
  const model =
    models.find((item) => item === wantedModel) ??
    models.find((item) => item === modelsQuery.data?.default) ??
    models[0]

  // 切好没发、又不是本次会话发起的编辑，草稿已经没了，不展示。
  const pending = useMemo(
    () => chain.pending.filter((edit) => edit.stage !== 'cut' || edit.key in drafts),
    [chain.pending, drafts],
  )
  const previewable = useMemo(() => pending.filter((edit) => edit.preview !== undefined), [pending])
  const selected = useMemo<Selected | undefined>(() => {
    const version = chain.versions.find((item) => item.key === selectedKey)
    if (version !== undefined)
      return { kind: 'version', key: version.key, label: version.label, version }
    const edit = previewable.find((item) => item.key === selectedKey)
    if (edit !== undefined) return { kind: 'pending', key: edit.key, label: edit.label, edit }
    const latest = chain.versions.at(-1)
    return latest === undefined
      ? undefined
      : { kind: 'version', key: latest.key, label: latest.label, version: latest }
  }, [chain.versions, previewable, selectedKey])
  const selectedKind = selected?.kind
  // 编辑结果一回来就把视线挪到它的预览上——合成按钮就在那里。一条只挪一次，正看着别的编辑时不抢；
  // 关掉重开也会落在等着合成的那条上，而不是根。渲染期调整状态，不绕一轮 effect。
  const [revealed, setRevealed] = useState<readonly string[]>([])
  const fresh = previewable.find((edit) => edit.stage === 'ready' && !revealed.includes(edit.key))
  if (fresh !== undefined) {
    setRevealed((current) => (current.includes(fresh.key) ? current : [...current, fresh.key]))
    if (selectedKind === 'version') setSelectedKey(fresh.key)
  }
  const selectedVersion = selected?.kind === 'version' ? selected.version : undefined
  const base =
    selected === undefined
      ? undefined
      : selected.kind === 'pending'
        ? selected.edit.base
        : chain.versions.find((item) => item.key === selected.version.edit?.baseKey)

  const urls = useMemo(() => {
    const seen = new Set<string>()
    for (const version of chain.versions) seen.add(version.mediaUrl)
    for (const edit of chain.pending)
      for (const segment of edit.preview ?? []) seen.add(segment.mediaUrl)
    return [...seen]
  }, [chain])
  // 本系统加工出来的视频（参考片段与成片）时长由后端量好随记录返回，不用再开播放器去探。
  const clipDurations = useMemo(() => {
    const known: Record<string, number> = {}
    for (const job of chainQuery.data?.items ?? [])
      if (job.kind === 'clip' && job.outputUrl !== null && job.durationMs !== null)
        known[job.outputUrl] = job.durationMs / 1000
    return known
  }, [chainQuery.data])
  const durations = useMediaDurations(urls, clipDurations)
  const currentSegments: PlaySegment[] | undefined =
    selected === undefined
      ? undefined
      : selected.kind === 'version'
        ? [{ mediaUrl: selected.version.mediaUrl, start: 0, role: 'base' }]
        : (selected.edit.preview ?? [])
  // 探过了却读不出时长：预览与合成都做不了，要说出来，不静默卡在占位文案上。
  const unreadable = (segments: readonly PlaySegment[] | undefined) =>
    segments?.some((segment) => durations[segment.mediaUrl] === null) ?? false
  // 轮询每次都重建版本对象，段列表按内容稳定住，播放器才不会被无谓地归零。
  const laid = useStableValue(
    currentSegments === undefined ? undefined : layoutSegments(currentSegments, durations),
  )
  const originalLaid = useStableValue(
    base === undefined
      ? undefined
      : layoutSegments([{ mediaUrl: base.mediaUrl, start: 0, role: 'base' }], durations),
  )
  const duration = laid === undefined ? undefined : totalDuration(laid)
  const durationOf = (url: string) => durations[url] ?? undefined
  const range =
    selectedVersion !== undefined && duration !== undefined && duration > 0
      ? clampRange(
          selection ?? { start: 0, end: Math.min(DEFAULT_RANGE_SECONDS, duration) },
          duration,
        )
      : undefined
  const menuEntries: VersionMenuEntry[] = [
    ...chain.versions.map((version) => ({
      key: version.key,
      label: version.label,
      baseLabel: chain.versions.find((item) => item.key === version.edit?.baseKey)?.label,
      note: undefined,
      mediaUrl: version.mediaUrl,
      duration: durationOf(version.mediaUrl),
    })),
    ...previewable.map((edit) => ({
      key: edit.key,
      label: edit.label,
      baseLabel: edit.base.label,
      note: STAGE_LABEL[edit.stage],
      mediaUrl: edit.video?.outputUrl ?? edit.base.mediaUrl,
      duration: undefined,
    })),
  ]
  // 编辑预览还没成版，来源链到它的基底为止。
  const ancestors =
    selected === undefined
      ? []
      : ancestorsOf(
          chain.versions,
          selected.kind === 'version' ? selected.version : selected.edit.base,
        )
  // 状态面板跟着看的那条走：选中了某条编辑就说它，否则说最要紧的那条。
  const shownEdit =
    selected?.kind === 'pending' ? selected.edit : (pending.find(isActive) ?? pending.at(-1))

  const seedJob = (job: GenerationJob) => {
    queryClient.setQueryData<{ items: GenerationJob[] }>(
      videoEditChainKey(conversationId, root.id),
      (previous) => ({
        items: [job, ...(previous?.items ?? []).filter((item) => item.id !== job.id)],
      }),
    )
    void queryClient.invalidateQueries({ queryKey: videoEditConversationKey(conversationId) })
  }

  // 第二步：参考片段切好了，按后端报的实际时长反算起点，把片段交给模型。
  useEffect(() => {
    for (const edit of chain.pending) {
      const clipUrl = edit.reference?.outputUrl
      const clipMs = edit.reference?.durationMs
      const draft = drafts[edit.key]
      if (edit.stage !== 'cut' || clipUrl == null || draft === undefined) continue
      if (submittedRef.current.has(edit.key)) continue
      // 没带时长的片段发不了，错误在渲染里按记录直接推出来，不在这里写状态。
      if (clipMs == null) continue
      submittedRef.current.add(edit.key)
      const metadata: VideoEditMetadata = {
        ...edit.coords,
        editStart: actualEditStart(edit.coords.editEnd, clipMs / 1000),
      }
      submitVideoEdit({
        conversationId,
        taskId: root.taskId,
        rootJobId: root.id,
        metadata,
        model: draft.model,
        prompt: draft.prompt,
        referenceVideoUrl: clipUrl,
        referenceImageUrls: draft.references.map((reference) => reference.url),
      })
        .then(() =>
          queryClient.invalidateQueries({ queryKey: videoEditConversationKey(conversationId) }),
        )
        .catch((error: unknown) => {
          setOperationError(error instanceof Error ? error.message : '视频编辑提交失败')
        })
    }
  }, [chain.pending, drafts, conversationId, root.id, root.taskId, queryClient])

  const select = (key: string) => {
    setSelectedKey(key)
    setOperationError(null)
  }
  const changeRange = (next: TimeRange, boundary: keyof TimeRange) => {
    if (duration === undefined) return
    // 调整起点只收紧这一端，不能把已有终点向后推。
    const bounded = clampRange(
      boundary === 'start'
        ? { ...next, start: Math.min(next.start, next.end - MIN_RANGE_SECONDS) }
        : next,
      duration,
    )
    if (bounded === undefined) return
    setSelection(bounded)
    setOperationError(null)
    previewRef.current?.previewAt(bounded[boundary], boundary)
  }
  const changeBoundary = (boundary: keyof TimeRange, value: number) => {
    if (range === undefined || duration === undefined || !Number.isFinite(value)) return
    changeRange({ ...range, [boundary]: value }, boundary)
  }

  const generate = async () => {
    if (busy || selectedVersion === undefined || range === undefined) return
    const text = prompt.trim()
    if (text === '') {
      setOperationError('先写下想怎么改')
      return
    }
    if (model === undefined) {
      setOperationError('没有可用的编辑模型')
      return
    }
    const editId = mintUuid()
    const metadata: VideoEditMetadata = {
      // 基于原片时 edit 为空，这一项就不写。
      ...(selectedVersion.edit === undefined ? {} : { baseEdit: selectedVersion.edit.editId }),
      editId,
      editStart: range.start,
      editEnd: range.end,
    }
    setDrafts((current) => ({ ...current, [editId]: { prompt: text, model, references } }))
    setOperation('cutting')
    setOperationError(null)
    try {
      seedJob(
        await submitReferenceClip({
          conversationId,
          taskId: root.taskId,
          rootJobId: root.id,
          metadata,
          url: selectedVersion.mediaUrl,
          start: range.start,
          end: range.end,
        }),
      )
    } catch (error) {
      setDrafts(({ [editId]: _dropped, ...rest }) => rest)
      setOperationError(error instanceof Error ? error.message : '切片任务提交失败')
    } finally {
      setOperation('idle')
    }
  }

  const compose = async (edit: PendingEdit) => {
    const segments =
      edit.preview === undefined ? undefined : layoutSegments(edit.preview, durations)
    if (busy || segments === undefined) return
    setOperation('composing')
    setOperationError(null)
    try {
      seedJob(
        await submitMasterClip({
          conversationId,
          taskId: root.taskId,
          rootJobId: root.id,
          metadata: edit.coords,
          segments: composeSegments(segments),
        }),
      )
      toast.success('已提交合成，完成后会成为新版本')
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : '合成任务提交失败')
    } finally {
      setOperation('idle')
    }
  }

  const canGenerate =
    !busy && selectedVersion !== undefined && range !== undefined && model !== undefined
  // 切好了却没带时长：反算不出起点，这次编辑发不出去。正常不会发生，不静默卡着。
  const clipDurationMissing = pending.some(
    (edit) =>
      edit.stage === 'cut' &&
      edit.reference?.outputUrl != null &&
      edit.reference.durationMs == null,
  )
  const canCompose = (edit: PendingEdit) =>
    !busy &&
    edit.preview !== undefined &&
    layoutSegments(edit.preview, durations) !== undefined &&
    (edit.stage === 'ready' || (edit.stage === 'failed' && edit.master !== undefined))
  // 等着合成，却因为读不到时长按不下去：按钮只会灰着，原因得另外说一句。只在看着那条时说，
  // 它正好和灰着的按钮同时在屏幕上。
  const composeBlocked =
    selected?.kind === 'pending' &&
    selected.edit.stage === 'ready' &&
    unreadable(selected.edit.preview)

  /** 时间线上那个主按钮：看某一版就下载它，看编辑预览就把它合成成片。 */
  const action =
    selected === undefined ? undefined : selected.kind === 'version' ? (
      <Button
        leadingIcon="download"
        loading={downloading}
        onClick={() => void download(selected.version.mediaUrl, '生成的视频')}
        size="md"
        variant="ghost"
      >
        下载
      </Button>
    ) : (
      <Button
        disabled={!canCompose(selected.edit)}
        loading={operation === 'composing' || selected.edit.stage === 'composing'}
        onClick={() => void compose(selected.edit)}
        size="md"
      >
        {selected.edit.stage === 'composing'
          ? '合成中'
          : selected.edit.master === undefined
            ? '合成成片'
            : '重新合成'}
      </Button>
    )

  return (
    <DialogRoot
      open
      onOpenChange={(open) => {
        if (open) return
        if (busy) toast.info('请等待提交完成')
        else onClose()
      }}
    >
      <DialogSurface
        aria-describedby={undefined}
        className="video-editor-dialog"
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogHeader
          className="video-editor-header border-0"
          closeLabel="关闭视频编辑"
          title={
            <span className="video-editor-title">
              <span>编辑视频</span>
              {shotIndex === undefined ? null : (
                <span className="text-body-sm font-normal text-on-surface-muted">
                  · 镜头组 {shotIndex}
                </span>
              )}
            </span>
          }
        />
        <div aria-label="视频编辑器" className="video-editor">
          <div className="video-editor-workspace">
            <EditorPreview
              current={laid}
              currentLabel={selected?.label ?? ''}
              currentTime={currentTime}
              onTime={setCurrentTime}
              original={base === undefined ? undefined : originalLaid}
              poster={selected === undefined ? undefined : posterOf(laid?.[0]?.mediaUrl ?? '')}
              ref={previewRef}
              selection={range ?? null}
            />
            <section aria-label="编辑选段" className="video-editor-inspector">
              <div className="video-editor-inspector-heading">
                <h3>编辑片段</h3>
              </div>
              <div className="video-editor-range">
                <Icon decorative name="duration" size="sm" />
                <label className="sr-only" htmlFor="video-range-start">
                  开始时间（秒）
                </label>
                <input
                  disabled={range === undefined || busy}
                  id="video-range-start"
                  max={duration}
                  min={0}
                  onChange={(event) => changeBoundary('start', event.currentTarget.valueAsNumber)}
                  step={0.1}
                  type="number"
                  value={range?.start ?? ''}
                />
                <Icon decorative name="next" size="sm" />
                <label className="sr-only" htmlFor="video-range-end">
                  结束时间（秒）
                </label>
                <input
                  disabled={range === undefined || busy}
                  id="video-range-end"
                  max={duration}
                  min={0}
                  onChange={(event) => changeBoundary('end', event.currentTarget.valueAsNumber)}
                  step={0.1}
                  type="number"
                  value={range?.end ?? ''}
                />
                <span>
                  {range === undefined ? '' : `${roundSeconds(range.end - range.start)}s`}
                </span>
              </div>
              <EditorComposer
                disabled={busy}
                footer={
                  <div className="video-editor-generation-controls">
                    <MenuRoot>
                      <MenuTrigger asChild>
                        <button
                          aria-label="编辑模型"
                          className="video-editor-model ui-focus"
                          disabled={busy || models.length === 0}
                          title={model}
                          type="button"
                        >
                          <span>{model ?? '没有支持编辑的模型'}</span>
                          <Icon decorative name="expand" size="sm" />
                        </button>
                      </MenuTrigger>
                      <MenuSurface
                        align="start"
                        aria-label="编辑模型"
                        aria-labelledby={undefined}
                        className="video-editor-model-menu"
                        collisionPadding={16}
                        side="top"
                        sideOffset={8}
                      >
                        <MenuRadioGroup onValueChange={setWantedModel} value={model ?? ''}>
                          {models.map((item) => (
                            <MenuRadioItem key={item} value={item}>
                              {item}
                            </MenuRadioItem>
                          ))}
                        </MenuRadioGroup>
                      </MenuSurface>
                    </MenuRoot>
                    <Button
                      className="video-editor-generate"
                      disabled={!canGenerate}
                      loading={operation === 'cutting'}
                      onClick={() => void generate()}
                      trailingIcon="send-up"
                    >
                      生成
                    </Button>
                  </div>
                }
                onBusyChange={(uploading) => setOperation(uploading ? 'uploading' : 'idle')}
                onPromptChange={(value) => {
                  setPrompt(value)
                  setOperationError(null)
                }}
                onReferencesChange={setReferences}
                prompt={prompt}
                references={references}
              />
              {selectedVersion !== undefined &&
              duration !== undefined &&
              duration < MIN_RANGE_SECONDS ? (
                <p className="video-editor-muted" role="status">
                  视频不足 1 秒，无法选择编辑片段。
                </p>
              ) : null}
              {selected?.kind === 'pending' ? (
                <p className="video-editor-muted">
                  正在看的是 {selected.label} 的预览；要继续编辑，先切回某一版。
                </p>
              ) : null}
              {modelsQuery.isError ? (
                <InlineAlert
                  action={{ label: '重新加载模型', onClick: () => void modelsQuery.refetch() }}
                  message={modelsQuery.error.message}
                />
              ) : null}
              {chainQuery.isError ? (
                <InlineAlert
                  action={{ label: '重试', onClick: () => void chainQuery.refetch() }}
                  message={chainQuery.error.message}
                />
              ) : null}
              {operationError === null ? null : <InlineAlert message={operationError} />}
              {clipDurationMissing ? (
                <InlineAlert message="参考片段没记下时长，请重新选段生成" />
              ) : null}
              {composeBlocked ? (
                <InlineAlert message="读不到编辑结果的时长，无法合成；关掉编辑器重开可再试一次" />
              ) : null}
              {shownEdit === undefined ? null : <EditorGenerationStatus edit={shownEdit} />}
            </section>
          </div>
          {selected !== undefined &&
          laid !== undefined &&
          duration !== undefined &&
          duration > 0 ? (
            <EditorTimeline
              action={action}
              ancestors={ancestors}
              // 根自己就是原片：上轨照样摆它。
              base={base ?? selectedVersion}
              baseDuration={durationOf((base ?? selectedVersion)?.mediaUrl ?? '')}
              currentTime={currentTime}
              duration={duration}
              entries={menuEntries}
              label={selected.label}
              onSeek={(time) => previewRef.current?.previewAt(time)}
              onSelect={select}
              onSelectionChange={changeRange}
              posterOf={posterOf}
              segments={laid}
              selectedKey={selected.key}
              selection={selectedVersion === undefined ? null : (range ?? null)}
            />
          ) : (
            // 时长读不出来时时间线摆不出来，但当前这一版该能下载，按钮跟着占位一起摆。
            <div className="video-editor-timeline-loading">
              <p role="status">
                {unreadable(currentSegments)
                  ? '读不到视频时长，无法预览与选段；关掉编辑器重开可再试一次'
                  : '读到视频时长后即可选择片段'}
              </p>
              {action}
            </div>
          )}
        </div>
      </DialogSurface>
    </DialogRoot>
  )
}
