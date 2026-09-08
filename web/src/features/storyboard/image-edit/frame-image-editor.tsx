import { useQueryClient, type InfiniteData } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { uploadMediaFile } from '@/shared/api/media-upload'
import { Icon } from '@/shared/icons'
import { formatDateTime } from '@/shared/lib/date-time'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { DialogHeader, DialogRoot, DialogSurface } from '@/shared/ui/dialog'
import { Select } from '@/shared/ui/field'
import { MediaLightbox } from '@/shared/ui/media-lightbox'
import { toast } from '@/shared/ui/toast'
import { isRunningStatus } from '../shots'
import type { GenerationJob } from '../storyboard.api'
import { AnnotationCanvas } from './annotation-canvas'
import { exportAnnotatedImage } from './annotation-export'
import { EditInstructionEditor } from './edit-instruction-editor'
import { EditReferences } from './edit-references'
import { editDraftError, editDraftKey, emptyEditDraft, loadEditDraft } from './image-edit-draft'
import {
  imageEditQueryKey,
  parseEditPrompt,
  readSubmittedImages,
  readSubmittedPrompt,
  resolveImageOptions,
  submitImageEdit,
  useImageEditJobs,
  useImageModels,
  type ImageChannel,
  type ImageResolution,
} from './image-edit.api'
import type { EditReference, FrameEditDraft, FrameEditTarget } from './image-edit-types'
import './image-edit.css'

/** 快照里只有地址，名字重新推一份：和当前帧同一张标「当前原图」，其余取文件名。 */
const restoredReference =
  (sourceUrl: string) =>
  (url: string): EditReference => ({
    id: crypto.randomUUID(),
    kind: 'image',
    url,
    label:
      url === sourceUrl
        ? '当前原图'
        : (decodeURIComponent(url.split('?')[0] ?? '')
            .split('/')
            .at(-1) ?? '图片'),
  })

type FrameImageEditorProps = {
  target: FrameEditTarget
  frames: readonly string[]
  aspectRatio: string
  onClose: () => void
  onApply: (url: string) => Promise<void>
}

export function FrameImageEditor({
  target,
  frames,
  aspectRatio,
  onClose,
  onApply,
}: FrameImageEditorProps) {
  const queryClient = useQueryClient()
  const [initial] = useState(() => {
    try {
      return { draft: loadEditDraft(target), error: null }
    } catch {
      return {
        draft: emptyEditDraft(),
        error: '本地编辑草稿读取失败，请重新开始或从编辑记录恢复输入',
      }
    }
  })
  const [draft, setDraft] = useState<FrameEditDraft>(initial.draft)
  const [draftError, setDraftError] = useState<string | null>(initial.error)
  const [selectedAnnotation, setSelectedAnnotation] = useState<string | null>(null)
  const [pendingInsertion, setPendingInsertion] = useState<{
    kind: 'annotation' | 'referenceImage'
    id: string
    requestId: number
  } | null>(null)
  const [preview, setPreview] = useState<EditReference | null>(null)
  const [mode, setMode] = useState<'edit' | 'original' | 'result'>('edit')
  const [wantedModel, setWantedModel] = useState<string>()
  const [wantedChannel, setWantedChannel] = useState<ImageChannel>('dev')
  const [wantedResolution, setWantedResolution] = useState<ImageResolution>('2k')
  const [submitting, setSubmitting] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [applying, setApplying] = useState(false)
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null)
  const [operationError, setOperationError] = useState<string | null>(null)
  const [canvasRevision, setCanvasRevision] = useState(0)
  const activeRef = useRef(false)
  const storageErrorRef = useRef(false)
  const insertionRef = useRef(0)
  const modelsQuery = useImageModels()
  const models = modelsQuery.data?.items ?? []
  const { model, resolution, channel, aspectUnsupported } = resolveImageOptions(
    models,
    aspectRatio,
    {
      model: wantedModel ?? modelsQuery.data?.default,
      channel: wantedChannel,
      resolution: wantedResolution,
    },
  )
  const jobsQuery = useImageEditJobs(target)
  const jobs = jobsQuery.data?.pages.flatMap((page) => page.items) ?? []
  // 列表已按这一格筛过，所以最新一条就是这一格的。
  const selectedJob =
    selectedJobId === null ? jobs[0] : jobs.find((job) => job.id === selectedJobId)
  const resultUrl = selectedJob?.status === 'completed' ? selectedJob.outputUrl : null
  const busy = submitting || uploading || applying
  const problem = editDraftError(draft)

  useEffect(() => {
    if (draftError !== null) return
    try {
      sessionStorage.setItem(editDraftKey(target), JSON.stringify(draft))
    } catch {
      if (!storageErrorRef.current) toast.error('编辑草稿无法暂存，关闭页面前请先提交生成')
      storageErrorRef.current = true
    }
  }, [draft, draftError, target])

  const changeDraft = (next: FrameEditDraft) => {
    setDraft(next)
    setOperationError(null)
  }
  const insert = (kind: 'annotation' | 'referenceImage', id: string) => {
    insertionRef.current += 1
    setPendingInsertion({ kind, id, requestId: insertionRef.current })
  }
  const previewReference = (reference: EditReference | null) => {
    if (reference?.kind === 'annotated') {
      setMode('edit')
      toast.info('画布正在显示当前标注图')
    } else setPreview(reference)
  }
  const submit = async () => {
    if (busy || activeRef.current) return
    if (problem !== null) {
      setOperationError(problem)
      return
    }
    activeRef.current = true
    setSubmitting(true)
    setOperationError(null)
    try {
      // 仅用户显式选中的标注图需要导出；原图和其他参考图不自动加入。
      const references: EditReference[] = []
      for (const reference of draft.references) {
        references.push(
          reference.kind === 'annotated'
            ? {
                ...reference,
                url: await uploadMediaFile(
                  await exportAnnotatedImage(target.sourceUrl, draft.annotations),
                  'image',
                ),
              }
            : reference,
        )
      }
      const snapshot = { ...draft, references }
      if (model === undefined || resolution === undefined) {
        setOperationError('图片模型还没读到，稍等一下再提交')
        return
      }
      const job = await submitImageEdit(target, snapshot, {
        aspectRatio,
        model: model.model,
        resolution,
        ...(channel === undefined ? {} : { channel }),
      })
      setDraft(snapshot)
      setSelectedJobId(job.id)
      queryClient.setQueryData<InfiniteData<{ items: GenerationJob[] }>>(
        imageEditQueryKey(target),
        (previous) => {
          if (previous === undefined) return { pages: [{ items: [job] }], pageParams: [undefined] }
          return {
            ...previous,
            pages: previous.pages.map((page, index) =>
              index === 0
                ? { items: [job, ...page.items.filter((item) => item.id !== job.id)] }
                : page,
            ),
          }
        },
      )
      void queryClient.invalidateQueries({ queryKey: imageEditQueryKey(target) })
      toast.success('图片编辑已提交，可以关闭窗口，稍后查看结果')
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : '图片编辑提交失败')
    } finally {
      activeRef.current = false
      setSubmitting(false)
    }
  }
  const apply = async () => {
    if (resultUrl === null || resultUrl === undefined || busy || activeRef.current) return
    activeRef.current = true
    setApplying(true)
    setOperationError(null)
    try {
      await onApply(resultUrl)
      try {
        sessionStorage.removeItem(editDraftKey(target))
      } catch {
        toast.info('图片已保存，但本地草稿清理失败')
      }
      toast.success('图片已应用并保存到当前帧')
      onClose()
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : '图片尚未应用，请重试')
    } finally {
      activeRef.current = false
      setApplying(false)
    }
  }

  return (
    <DialogRoot
      open
      onOpenChange={(open) => {
        if (!open) {
          if (busy) toast.info('请等待上传或保存完成')
          else onClose()
        }
      }}
    >
      <DialogSurface
        aria-describedby={undefined}
        className="image-edit-dialog"
        onInteractOutside={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => {
          // Dialog 先于画布捕获 Escape；画布内取消笔迹/选择时不能关闭编辑器。
          if (selectedAnnotation !== null) {
            event.preventDefault()
            setSelectedAnnotation(null)
          } else if (
            event.target instanceof Element &&
            event.target.closest('[data-annotation-canvas]')
          ) {
            event.preventDefault()
          }
        }}
      >
        <DialogHeader title="编辑图片" closeLabel="关闭图片编辑">
          <p className="mt-1 text-body-sm text-on-surface-muted">
            镜头组 {target.shotIndex} · 帧 @{target.frameNumber}
          </p>
        </DialogHeader>
        <div className="image-edit-body">
          <div className="image-edit-left">
            <div className="image-edit-view-tabs" role="group" aria-label="图片编辑视图">
              {(
                [
                  ['edit', '标注编辑'],
                  ['original', '原图'],
                  ['result', '编辑结果'],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  disabled={value === 'result' && !resultUrl}
                  aria-pressed={mode === value}
                  className={cn(
                    'rounded-sm px-3 py-2 text-body-sm ui-focus disabled:opacity-40',
                    mode === value ? 'bg-primary/8 text-primary' : 'text-on-surface-muted',
                  )}
                  onClick={() => setMode(value)}
                >
                  {label}
                </button>
              ))}
              {resultUrl ? (
                <span className="ml-auto text-caption text-on-surface-muted">结果尚未应用</span>
              ) : null}
            </div>
            <div className="image-edit-canvas-slot" hidden={mode !== 'edit'}>
              <AnnotationCanvas
                key={canvasRevision}
                url={target.sourceUrl}
                annotations={draft.annotations}
                onChange={(annotations) => changeDraft({ ...draft, annotations })}
                selectedId={selectedAnnotation}
                onSelect={setSelectedAnnotation}
                disabled={busy}
                onInsertReference={(id) => insert('annotation', id)}
              />
            </div>
            {mode !== 'edit' ? (
              <div className="image-edit-photo">
                <img
                  alt={mode === 'original' ? '编辑前的原图' : '图片编辑结果'}
                  src={mode === 'original' ? target.sourceUrl : (resultUrl ?? undefined)}
                />
              </div>
            ) : null}
          </div>
          <div className="image-edit-right">
            <section className="flex flex-col gap-3">
              <h3 className="text-body font-medium">修改要求</h3>
              <EditInstructionEditor
                value={draft.instructions}
                onChange={(instructions) => changeDraft({ ...draft, instructions })}
                annotations={draft.annotations}
                references={draft.references}
                selectedAnnotationId={selectedAnnotation}
                disabled={busy}
                onSelectAnnotation={(id) => {
                  setSelectedAnnotation(id)
                  setMode('edit')
                }}
                onPreviewReference={(id) =>
                  previewReference(
                    draft.references.find((reference) => reference.id === id) ?? null,
                  )
                }
                pendingInsertion={pendingInsertion}
                onInserted={() => setPendingInsertion(null)}
              />
            </section>
            <EditReferences
              references={draft.references}
              frames={frames}
              currentFrame={target.frameNumber}
              sourceUrl={target.sourceUrl}
              hasAnnotations={draft.annotations.length > 0}
              disabled={busy}
              onChange={(references) => changeDraft({ ...draft, references })}
              onBusyChange={setUploading}
              onInsertReference={(id) => insert('referenceImage', id)}
              onPreview={previewReference}
            />
            <div className="flex flex-wrap items-center gap-2 rounded-sm border border-outline-variant px-3 py-2">
              <Icon
                decorative
                name="edit-image"
                size="sm"
                className="shrink-0 text-on-surface-muted"
              />
              {aspectUnsupported ? (
                <span role="alert" className="text-body-sm text-error">
                  没有哪家模型出得了 {aspectRatio}，改分镜画幅才能编辑这一帧
                </span>
              ) : (
                <>
                  <Select
                    className="mr-auto w-auto"
                    aria-label="图片模型"
                    value={model?.model ?? ''}
                    disabled={busy || models.length === 0}
                    onChange={(event) => setWantedModel(event.target.value)}
                  >
                    {models.map((item) => {
                      const usable = item.aspectRatios.includes(aspectRatio)
                      return (
                        <option key={item.model} value={item.model} disabled={!usable}>
                          {usable ? item.label : `${item.label}（出不了 ${aspectRatio}）`}
                        </option>
                      )
                    })}
                  </Select>
                  {channel === undefined ? null : (
                    <label className="flex items-center gap-1 text-caption text-on-surface-muted">
                      渠道
                      <Select
                        className="w-auto"
                        aria-label="图片生成渠道"
                        value={channel}
                        disabled={busy}
                        onChange={(event) => setWantedChannel(event.target.value as ImageChannel)}
                      >
                        {model?.channels.map((value) => (
                          <option key={value} value={value}>
                            {value}
                          </option>
                        ))}
                      </Select>
                    </label>
                  )}
                  <Select
                    className="w-auto"
                    aria-label="图片分辨率"
                    value={resolution ?? ''}
                    disabled={busy}
                    onChange={(event) => setWantedResolution(event.target.value as ImageResolution)}
                  >
                    {model?.resolutions.map((value) => (
                      <option key={value} value={value}>
                        {value.toUpperCase()}
                      </option>
                    ))}
                  </Select>
                  <span className="text-caption text-on-surface-muted">{aspectRatio}</span>
                </>
              )}
            </div>
            {draftError !== null ? (
              <div role="alert" className="text-body-sm text-error">
                {draftError}
                <button
                  type="button"
                  className="ml-2 underline ui-focus"
                  onClick={() => {
                    setDraft(emptyEditDraft())
                    setDraftError(null)
                  }}
                >
                  重新开始
                </button>
              </div>
            ) : null}
            {operationError !== null ? (
              <p className="text-body-sm text-error" role="alert">
                {operationError}
              </p>
            ) : null}
            {selectedJob && isRunningStatus(selectedJob.status) ? (
              <p role="status" className="flex items-center gap-2 text-body-sm text-primary">
                <Icon decorative name="loading" className="animate-spin" size="sm" />
                图片生成中，关闭窗口后仍会继续
              </p>
            ) : null}
            {selectedJob?.status === 'failed' ? (
              <p role="alert" className="text-body-sm text-error">
                {selectedJob.errorMessage ?? '图片编辑失败，请调整后重新提交'}
              </p>
            ) : null}
            {resultUrl && mode !== 'result' ? (
              <Button
                leadingIcon="preview"
                size="md"
                variant="outlined"
                onClick={() => setMode('result')}
              >
                查看编辑结果
              </Button>
            ) : null}
            <details className="border-t border-outline-variant pt-3">
              <summary className="cursor-pointer text-body-sm text-on-surface-muted ui-focus">
                编辑记录 {jobs.length > 0 ? `(${jobs.length})` : ''}
              </summary>
              {jobsQuery.isError ? (
                <p className="mt-3 text-body-sm text-error" role="alert">
                  {jobsQuery.error.message}
                  <button
                    type="button"
                    className="ml-2 underline"
                    onClick={() => void jobsQuery.refetch()}
                  >
                    重试
                  </button>
                </p>
              ) : null}
              <div className="mt-3 flex flex-col gap-3">
                {jobs.map((job) => (
                  <div
                    key={job.id}
                    className="flex items-center justify-between gap-2 text-caption"
                  >
                    <button
                      className="min-w-0 truncate text-left ui-focus"
                      type="button"
                      onClick={() => {
                        setSelectedJobId(job.id)
                        if (job.status === 'completed') setMode('result')
                      }}
                    >
                      {job.status === 'completed'
                        ? '已生成'
                        : isRunningStatus(job.status)
                          ? '生成中'
                          : '失败'}{' '}
                      · {formatDateTime(job.createdAt)}
                    </button>
                    <button
                      className="shrink-0 rounded-xs text-primary ui-focus disabled:opacity-40"
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        const urls = readSubmittedImages(job)
                        if (urls.length === 0) {
                          toast.error('这条记录没有可恢复的输入')
                          return
                        }
                        const references = urls.map(restoredReference(target.sourceUrl))
                        changeDraft({
                          // 画布上的圈没存，恢复不出来；那张烙好的标注图还在图片列表里。
                          annotations: [],
                          instructions: parseEditPrompt(readSubmittedPrompt(job), references),
                          references,
                        })
                        setDraftError(null)
                        setSelectedAnnotation(null)
                        setCanvasRevision((value) => value + 1)
                        setMode('edit')
                        setSelectedJobId(job.id)
                        toast.info('已装回这次提交的图片和修改要求；画布上的标注需要重画')
                      }}
                    >
                      恢复输入
                    </button>
                  </div>
                ))}
                {jobsQuery.hasNextPage ? (
                  <button
                    className="text-left text-caption text-primary ui-focus"
                    type="button"
                    disabled={jobsQuery.isFetchingNextPage}
                    onClick={() => void jobsQuery.fetchNextPage()}
                  >
                    更早的记录
                  </button>
                ) : null}
              </div>
            </details>
          </div>
        </div>
        <footer className="image-edit-footer">
          <p className="flex max-w-md items-center gap-2 text-caption text-on-surface-muted">
            <Icon decorative name="reference" size="sm" />
            {mode === 'result'
              ? '确认并保存后，只替换当前帧'
              : '标注用于说明修改位置；引用标注时请选择标注图'}
          </p>
          <div className="flex shrink-0 gap-2">
            {mode === 'result' && resultUrl ? (
              <>
                <Button
                  variant="outlined"
                  size="md"
                  disabled={busy}
                  onClick={() => setMode('edit')}
                >
                  继续修改
                </Button>
                <Button size="md" disabled={busy} loading={applying} onClick={() => void apply()}>
                  应用到当前帧
                </Button>
              </>
            ) : (
              <Button
                size="md"
                className="min-w-48"
                disabled={busy || draftError !== null || model === undefined}
                loading={submitting}
                onClick={() => void submit()}
              >
                生成编辑结果
              </Button>
            )}
          </div>
        </footer>
        {preview !== null ? (
          <MediaLightbox
            media={{
              kind: 'image',
              name: preview.label,
              url: preview.kind === 'annotated' ? target.sourceUrl : preview.url,
            }}
            onClose={() => setPreview(null)}
          />
        ) : null}
      </DialogSurface>
    </DialogRoot>
  )
}
