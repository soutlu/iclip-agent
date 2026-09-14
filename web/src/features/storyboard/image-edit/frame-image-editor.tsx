import { useQueryClient, type InfiniteData } from '@tanstack/react-query'
import { useMemo, useRef, useState } from 'react'
import { uploadMediaFile } from '@/shared/api/media-upload'
import { mintUuid } from '@/shared/lib/uuid'
import { Button, IconButton } from '@/shared/ui/button'
import { DialogHeader, DialogRoot, DialogSurface } from '@/shared/ui/dialog'
import { MediaLightbox } from '@/shared/ui/media-lightbox'
import { MenuItem, MenuRoot, MenuSurface, MenuTrigger } from '@/shared/ui/menu'
import { toast } from '@/shared/ui/toast'
import { readStoryboardMetadata } from '../generation-metadata'
import type { GenerationJob } from '../storyboard.api'
import { AnnotationCanvas } from './annotation-canvas'
import { exportAnnotatedImage } from './annotation-export'
import { EditGenerationSettings } from './edit-generation-settings'
import { CURRENT_KEY, entryBaseUrl, frameImageEntries } from './edit-history'
import { EditInstructionEditor } from './edit-instruction-editor'
import { EditReferences } from './edit-references'
import { EditResultStrip } from './edit-result-strip'
import { EditTaskPreview } from './edit-task-preview'
import { draftOf, editDraftError } from './image-edit-draft'
import {
  imageEditConversationKey,
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
import type { EditReference, FrameEditTarget } from './image-edit-types'
import { useFrameEditDrafts } from './use-frame-edit-drafts'
import './image-edit.css'

/** 快照里只有地址，名字重新推一份：和这次底图同一张标「编辑底图」，其余取文件名。 */
const restoredReference =
  (baseUrl: string) =>
  (url: string): EditReference => ({
    id: mintUuid(),
    kind: 'image',
    url,
    label:
      url === baseUrl
        ? '编辑底图'
        : (decodeURIComponent(url.split('?')[0] ?? '')
            .split('/')
            .at(-1) ?? '图片'),
  })

type FrameImageEditorProps = {
  target: FrameEditTarget
  frames: readonly string[]
  aspectRatio: string
  /** 打开时先选中哪一条；从帧上「有新结果」进来时是那条任务。 */
  initialKey?: string | undefined
  onClose: () => void
  onApply: (previousUrl: string, url: string) => Promise<void>
}

export function FrameImageEditor({
  target,
  frames,
  aspectRatio,
  initialKey,
  onClose,
  onApply,
}: FrameImageEditorProps) {
  const queryClient = useQueryClient()
  const drafts = useFrameEditDrafts(target)
  const [selectedKey, setSelectedKey] = useState(initialKey ?? CURRENT_KEY)
  const [selectedAnnotation, setSelectedAnnotation] = useState<string | null>(null)
  const [pendingInsertion, setPendingInsertion] = useState<{
    kind: 'annotation' | 'referenceImage'
    id: string
    requestId: number
  } | null>(null)
  const [preview, setPreview] = useState<EditReference | null>(null)
  // 记地址而不是布尔：换一条结果就该重新试着加载那张图。
  const [brokenResult, setBrokenResult] = useState<string | null>(null)
  const [wantedModel, setWantedModel] = useState<string>()
  const [wantedChannel, setWantedChannel] = useState<ImageChannel>('dev')
  const [wantedResolution, setWantedResolution] = useState<ImageResolution>('2k')
  // 三段互斥的写操作：同一时刻只可能有一段在跑，编辑器其余部分按 busy 一起锁住。
  const [operation, setOperation] = useState<'idle' | 'uploading' | 'submitting' | 'applying'>(
    'idle',
  )
  const [operationError, setOperationError] = useState<string | null>(null)
  const [canvasRevision, setCanvasRevision] = useState(0)
  // 用户确认过的当前帧，应用时拿它当替换凭据。
  //
  // 不能跟着渲染走：这一帧被 agent 换掉时，缩略图条上那一小格会悄悄改一张图，用户盯着结果
  // 根本不会发现，跟着走等于没有守卫，会直接盖掉别人刚写的。也不能锁死在打开那一刻，否则
  // 应用完窗口留着就再也对不上。所以只在用户确实看过这一格时更新：翻缩略图条、自己应用成功、
  // 以及被拒绝一次之后。
  const acknowledgedRef = useRef<string | undefined>(undefined)
  const activeRef = useRef(false)
  const insertionRef = useRef(0)
  const modelsQuery = useImageModels()
  const models = modelsQuery.data?.items ?? []
  const options = resolveImageOptions(models, aspectRatio, {
    model: wantedModel ?? modelsQuery.data?.default,
    channel: wantedChannel,
    resolution: wantedResolution,
  })
  const { model, resolution, channel } = options
  const jobsQuery = useImageEditJobs(target)
  const jobs = useMemo(
    () => jobsQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [jobsQuery.data],
  )
  // 当前帧随应用实时变；编辑器不记打开那一刻的地址，不然应用完窗口还留着就对不上了。
  const currentUrl = frames[target.frameNumber - 1]
  acknowledgedRef.current ??= currentUrl
  const entries = useMemo(() => frameImageEntries(jobs, currentUrl ?? ''), [jobs, currentUrl])
  // 选中的那条被折进当前帧格（刚应用过）或还没拉回来时，落回当前帧。
  const selected = entries.find((entry) => entry.key === selectedKey) ?? entries[0]
  const baseUrl = selected === undefined ? '' : entryBaseUrl(selected, currentUrl ?? '')
  const draft = useMemo(() => draftOf(drafts.drafts, baseUrl), [drafts.drafts, baseUrl])
  const busy = operation !== 'idle'
  const problem = editDraftError(draft)
  const canApply =
    selected?.kind === 'image' && currentUrl !== undefined && selected.url !== currentUrl

  const changeDraft = (next: typeof draft) => {
    drafts.updateDraft(baseUrl, next)
    setOperationError(null)
  }
  const insert = (kind: 'annotation' | 'referenceImage', id: string) => {
    insertionRef.current += 1
    setPendingInsertion({ kind, id, requestId: insertionRef.current })
  }
  const select = (key: string) => {
    setSelectedKey(key)
    setSelectedAnnotation(null)
    setOperationError(null)
    // 翻看缩略图条时正好看见了当前帧那一格。
    acknowledgedRef.current = currentUrl
  }
  // 标注图没有独立地址，预览时看的是底图本身（见下面的 MediaLightbox）。
  const previewReference = (reference: EditReference | null) => setPreview(reference)
  const submit = async () => {
    if (busy || activeRef.current) return
    if (problem !== null) {
      setOperationError(problem)
      return
    }
    if (model === undefined || resolution === undefined) {
      setOperationError('图片模型还没读到，稍等一下再提交')
      return
    }
    activeRef.current = true
    setOperation('submitting')
    setOperationError(null)
    try {
      // 仅用户选中的标注图需要导出；普通图片直接使用列表中的地址。
      const references: EditReference[] = []
      for (const reference of draft.references) {
        references.push(
          reference.kind === 'annotated'
            ? {
                ...reference,
                url: await uploadMediaFile(
                  await exportAnnotatedImage(baseUrl, draft.annotations),
                  'image',
                ),
              }
            : reference,
        )
      }
      const snapshot = { ...draft, references }
      const job = await submitImageEdit(target, snapshot, baseUrl, {
        aspectRatio,
        model: model.model,
        resolution,
        ...(channel === undefined ? {} : { channel }),
      })
      drafts.updateDraft(baseUrl, snapshot)
      setSelectedKey(job.id)
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
      // 失效到对话前缀：分镜页帧上的角标也读这个前缀，新任务才会立刻冒出来。
      void queryClient.invalidateQueries({
        queryKey: imageEditConversationKey(target.conversationId),
      })
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : '图片编辑提交失败')
    } finally {
      activeRef.current = false
      setOperation('idle')
    }
  }
  const apply = async () => {
    if (!canApply || busy || activeRef.current) return
    const applied = selected.url
    activeRef.current = true
    setOperation('applying')
    setOperationError(null)
    try {
      await onApply(acknowledgedRef.current ?? currentUrl, applied)
      // 这张图成了当前帧，画在它上面的圈是上一轮的输入，留着只会误导。
      drafts.clearDraft(applied)
      acknowledgedRef.current = applied
      setSelectedKey(CURRENT_KEY)
      toast.success('已应用到当前帧')
    } catch (error) {
      // 多半是这一帧被 agent 换过了：报出来的同时认下新的那张，用户再点一次就是冲着它去的。
      acknowledgedRef.current = currentUrl
      setOperationError(error instanceof Error ? error.message : '图片尚未应用，请重试')
    } finally {
      activeRef.current = false
      setOperation('idle')
    }
  }

  const restoreInputs = () => {
    const job = selected?.job
    if (job === undefined || job === null) return
    const urls = readSubmittedImages(job)
    if (urls.length === 0) {
      toast.error('这条记录没有可恢复的输入')
      return
    }
    // 草稿归属于底图。恢复时也切回它，避免画面和装回的输入指向不同图片。
    const wanted = readStoryboardMetadata(job)?.sourceUrl ?? currentUrl
    const onBase = entries.find(
      (entry) => (entry.kind === 'image' || entry.kind === 'current') && entry.url === wanted,
    )
    const destination = onBase ?? entries[0]
    if (destination === undefined) return
    const base = entryBaseUrl(destination, currentUrl ?? '')
    const references = urls.map(restoredReference(base))
    drafts.updateDraft(base, {
      // 保存的是带标注的图片，无法还原画布上可编辑的圈与编号。
      annotations: [],
      instructions: parseEditPrompt(readSubmittedPrompt(job), references),
      references,
    })
    setCanvasRevision((value) => value + 1)
    select(destination.key)
    toast.info('已装回这次提交的图片和修改要求；画布上的标注需要重画')
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
        <DialogHeader
          className="image-edit-header border-0"
          title={
            <span className="image-edit-title">
              <span>编辑图片</span>{' '}
              <span className="text-body-sm font-normal text-on-surface-muted">
                · 镜头组 {target.shotIndex} · 帧 @{target.frameNumber}
              </span>
            </span>
          }
          closeLabel="关闭图片编辑"
        />
        <div className="image-edit-body">
          <div className="image-edit-left">
            {currentUrl === undefined ? (
              <p className="image-edit-photo text-body-sm text-on-surface-muted" role="alert">
                这一帧已经不在分镜里了，关掉窗口重新选一帧
              </p>
            ) : selected?.kind === 'pending' || selected?.kind === 'failed' ? (
              <EditTaskPreview
                key={`${selected.key}:${baseUrl}`}
                entry={selected}
                baseUrl={baseUrl}
                disabled={busy}
                onReturnToCurrent={() => select(CURRENT_KEY)}
              />
            ) : selected?.kind === 'image' ? (
              brokenResult === selected.url ? (
                <p className="image-edit-photo text-body-sm text-on-surface-muted">
                  这张图暂时无法显示
                </p>
              ) : (
                <div className="image-edit-photo">
                  <img
                    alt="图片编辑结果"
                    src={selected.url}
                    onError={() => setBrokenResult(selected.url)}
                  />
                </div>
              )
            ) : (
              <div className="image-edit-canvas-slot">
                <AnnotationCanvas
                  key={`${baseUrl}:${canvasRevision}`}
                  url={baseUrl}
                  annotations={draft.annotations}
                  onChange={(annotations) => changeDraft({ ...draft, annotations })}
                  selectedId={selectedAnnotation}
                  onSelect={setSelectedAnnotation}
                  disabled={busy}
                  onInsertReference={(id) => insert('annotation', id)}
                />
              </div>
            )}
            <EditResultStrip
              entries={entries}
              currentUrl={currentUrl ?? ''}
              disabled={busy}
              selectedKey={selected?.key ?? CURRENT_KEY}
              onSelect={select}
              hasMore={jobsQuery.hasNextPage}
              loadingMore={jobsQuery.isFetchingNextPage}
              onLoadMore={() => void jobsQuery.fetchNextPage()}
              actions={
                selected !== undefined && selected.kind !== 'current' && selected.job !== null ? (
                  <MenuRoot>
                    <MenuTrigger asChild>
                      <IconButton
                        disabled={busy}
                        label="图片历史操作"
                        name="more"
                        size="md"
                        className="rounded-full"
                      />
                    </MenuTrigger>
                    <MenuSurface align="end">
                      <MenuItem icon="history" disabled={busy} onSelect={restoreInputs}>
                        恢复这次的输入
                      </MenuItem>
                    </MenuSurface>
                  </MenuRoot>
                ) : null
              }
            />
          </div>
          <div className="image-edit-right">
            <div className="image-edit-inputs">
              <section className="flex flex-col gap-4">
                <div>
                  <h3 className="text-title-lg font-semibold">想怎么修改？</h3>
                  <p className="mt-1 text-body-sm text-on-surface-muted">
                    描述你的想法，也可以引用图片或标注
                  </p>
                </div>
                <EditInstructionEditor
                  key={baseUrl}
                  value={draft.instructions}
                  onChange={(instructions) => changeDraft({ ...draft, instructions })}
                  annotations={draft.annotations}
                  references={draft.references}
                  selectedAnnotationId={selectedAnnotation}
                  disabled={busy}
                  // 芯片指的是画在当前底图上的圈，选中的那条条目不变。
                  onSelectAnnotation={setSelectedAnnotation}
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
                baseUrl={baseUrl}
                hasAnnotations={draft.annotations.length > 0}
                disabled={busy}
                onChange={(references) => changeDraft({ ...draft, references })}
                // 参考图上传只会从空闲态发起，结束时直接回到空闲。
                onBusyChange={(uploading) => setOperation(uploading ? 'uploading' : 'idle')}
                onInsertReference={(id) => insert('referenceImage', id)}
                onPreview={previewReference}
              />
            </div>
            <div className="image-edit-submit-area">
              <EditGenerationSettings
                models={models}
                options={options}
                aspectRatio={aspectRatio}
                disabled={busy}
                onModelChange={setWantedModel}
                onChannelChange={setWantedChannel}
                onResolutionChange={setWantedResolution}
              />
              {modelsQuery.isError ? (
                <p role="alert" className="text-body-sm text-error">
                  {modelsQuery.error.message}
                  <button
                    className="ml-2 underline ui-focus"
                    type="button"
                    onClick={() => void modelsQuery.refetch()}
                  >
                    重新加载模型
                  </button>
                </p>
              ) : null}
              {drafts.error !== null ? (
                <div role="alert" className="text-body-sm text-error">
                  {drafts.error}
                  <button type="button" className="ml-2 underline ui-focus" onClick={drafts.reset}>
                    重新开始
                  </button>
                </div>
              ) : null}
              {jobsQuery.isError ? (
                <p className="text-body-sm text-error" role="alert">
                  {jobsQuery.error.message}
                  <button
                    type="button"
                    className="ml-2 underline ui-focus"
                    onClick={() => void jobsQuery.refetch()}
                  >
                    重试
                  </button>
                </p>
              ) : null}
              {operationError !== null ? (
                <p className="text-body-sm text-error" role="alert">
                  {operationError}
                </p>
              ) : null}
              {canApply ? (
                <Button
                  className="image-edit-primary-action"
                  disabled={busy}
                  loading={operation === 'applying'}
                  onClick={() => void apply()}
                >
                  应用到当前帧
                </Button>
              ) : null}
              <Button
                className="image-edit-primary-action"
                variant={canApply ? 'ghost' : 'primary'}
                disabled={
                  busy || drafts.error !== null || model === undefined || currentUrl === undefined
                }
                loading={operation === 'submitting'}
                onClick={() => void submit()}
              >
                生成图片
              </Button>
              <p className="text-center text-caption text-on-surface-muted">
                {canApply ? '应用只替换当前帧，之后可以继续修改' : '满意后再应用到当前帧'}
              </p>
            </div>
          </div>
        </div>
        {preview !== null ? (
          <MediaLightbox
            media={{
              kind: 'image',
              name: preview.label,
              url: preview.kind === 'annotated' ? baseUrl : preview.url,
            }}
            onClose={() => setPreview(null)}
          />
        ) : null}
      </DialogSurface>
    </DialogRoot>
  )
}
