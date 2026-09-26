/** 视频编辑器：选中一段交给模型改，预览拼好的整条，满意再合成成片。
 *
 * 编辑进行到哪一步不存在本地：每次渲染都从这条出片名下的编辑段与合成推出来，关掉重开、刷新都还在。
 * 切参考片段与拼接都在服务端，这里只提交基底、区间与编辑段。 */

import { useQueryClient } from '@tanstack/react-query'
import { useMemo, useRef, useState } from 'react'
import { errorMessageOf } from '@/shared/api/client'
import { useMediaDownload } from '@/shared/api/media-download'
import { videoSnapshotUrl } from '@/shared/lib/media-url'
import { Button } from '@/shared/ui/button'
import { DialogBody, DialogHeader, DialogRoot, DialogSurface } from '@/shared/ui/dialog'
import { toast } from '@/shared/ui/toast'
import { useVideoModels, type GenerationJob } from '../storyboard.api'
import {
  EDIT_STAGE_LABEL,
  ancestorsOf,
  isComposite,
  layoutSegments,
  projectEditChain,
  totalDuration,
  type ChainVersion,
  type PendingEdit,
  type PlaySegment,
} from './edit-chain'
import { EditorComposer, type EditorReference } from './editor-composer'
import { EditorGenerationStatus } from './editor-generation-status'
import { EditorModelMenu } from './editor-model-menu'
import { EditorNotices } from './editor-notices'
import { EditorPreview, type EditorPreviewHandle } from './editor-preview'
import { EditorRangeFields } from './editor-range-fields'
import { EditorTimeline } from './editor-timeline'
import type { VersionMenuEntry } from './editor-version-menu'
import { clampRange, MIN_RANGE_SECONDS, type TimeRange } from './time-range'
import { useMediaDurations } from './use-media-durations'
import { useStableValue } from './use-stable-value'
import {
  editableModels,
  pickEditModel,
  seedVideoEditJob,
  submitVideoComposite,
  submitVideoEdit,
  useVideoEditChain,
} from './video-editor.api'

const DEFAULT_RANGE_SECONDS = 4
const posterOf = (url: string) => videoSnapshotUrl(url, 320)
const isActive = (edit: PendingEdit) => edit.stage !== 'ready' && edit.stage !== 'failed'

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
  // 两次互斥的提交加上传参考图；任一在跑时整个编辑器一起锁。
  const [operation, setOperation] = useState<'idle' | 'uploading' | 'generating' | 'composing'>(
    'idle',
  )
  const [operationError, setOperationError] = useState<string | null>(null)
  const { downloading, download } = useMediaDownload()
  const busy = operation !== 'idle'
  const model = pickEditModel(models, wantedModel, modelsQuery.data?.default)

  const pending = chain.pending
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
  // 合成出来的视频时长由后端量好随记录返回，不用再开播放器去探。
  const clipDurations = useMemo(() => {
    const known: Record<string, number> = {}
    for (const job of chainQuery.data?.items ?? [])
      if (isComposite(job) && job.outputUrl !== null && job.durationMs !== null)
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
      note: EDIT_STAGE_LABEL[edit.stage],
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

  const seedJob = (job: GenerationJob) =>
    seedVideoEditJob(queryClient, conversationId, root.id, job)

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
    setOperation('generating')
    setOperationError(null)
    try {
      seedJob(
        await submitVideoEdit({
          conversationId,
          taskId: root.taskId,
          sourceJobId: selectedVersion.jobId,
          rangeStartMs: Math.round(range.start * 1000),
          rangeEndMs: Math.round(range.end * 1000),
          model,
          prompt: text,
          referenceImageUrls: references.map((reference) => reference.url),
        }),
      )
    } catch (error) {
      setOperationError(errorMessageOf(error, '视频编辑提交失败'))
    } finally {
      setOperation('idle')
    }
  }

  const compose = async (edit: PendingEdit) => {
    // 预览排不出来的不让合成，与按钮的可用条件一致。
    if (busy || edit.preview === undefined || layoutSegments(edit.preview, durations) === undefined)
      return
    setOperation('composing')
    setOperationError(null)
    try {
      seedJob(
        await submitVideoComposite({
          conversationId,
          taskId: root.taskId,
          sourceJobId: edit.video.id,
        }),
      )
      toast.success('已提交合成，完成后会成为新版本')
    } catch (error) {
      setOperationError(errorMessageOf(error, '合成任务提交失败'))
    } finally {
      setOperation('idle')
    }
  }

  const canGenerate =
    !busy && selectedVersion !== undefined && range !== undefined && model !== undefined
  const canCompose = (edit: PendingEdit) =>
    !busy &&
    edit.preview !== undefined &&
    layoutSegments(edit.preview, durations) !== undefined &&
    (edit.stage === 'ready' || (edit.stage === 'failed' && edit.composite !== undefined))
  // 只在看着那条时说，它正好和灰着的合成按钮同时在屏幕上。
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
          : selected.edit.composite === undefined
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
              <EditorRangeFields
                disabled={busy}
                duration={duration}
                onChange={changeBoundary}
                range={range}
              />
              <EditorComposer
                disabled={busy}
                footer={
                  <div className="video-editor-generation-controls">
                    <EditorModelMenu
                      disabled={busy}
                      model={model}
                      models={models}
                      onChange={setWantedModel}
                    />
                    <Button
                      className="video-editor-generate"
                      disabled={!canGenerate}
                      loading={operation === 'generating'}
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
              <EditorNotices
                chainError={
                  chainQuery.isError
                    ? errorMessageOf(chainQuery.error, '读取编辑记录失败')
                    : undefined
                }
                composeBlocked={composeBlocked}
                modelsError={
                  modelsQuery.isError
                    ? errorMessageOf(modelsQuery.error, '读取视频模型失败')
                    : undefined
                }
                onReloadChain={() => void chainQuery.refetch()}
                onReloadModels={() => void modelsQuery.refetch()}
                operationError={operationError}
                previewing={selected?.kind === 'pending' ? selected.label : undefined}
                tooShort={
                  selectedVersion !== undefined &&
                  duration !== undefined &&
                  duration < MIN_RANGE_SECONDS
                }
              />
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
