/** 结构化分镜工作台；查询参数保存组与帧位置，草稿局部更新后整份保存。 */

import { useQueryClient } from '@tanstack/react-query'
import type { ConversationFileEnvelope } from '@/shared/api/generated/types.gen'
import { useNavigate, useSearch } from '@tanstack/react-router'
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { Icon } from '@/shared/icons'
import { copyText as writeClipboard } from '@/shared/lib/clipboard'
import { cn } from '@/shared/lib/utils'
import { Button, IconButton } from '@/shared/ui/button'
import { MediaLightbox, type LightboxMedia } from '@/shared/ui/media-lightbox'
import { toast } from '@/shared/ui/toast'
import {
  workspaceQueryKeys,
  useWorkbenchSelection,
  useWorkspaceFile,
  type ArtifactRendererProps,
  type WorkbenchRef,
} from '@/shared/workbench'
import {
  formatShotPrompt,
  formatShotPrompts,
  parseShotsDocument,
  shotName,
  validateShot,
  type Shot,
} from '../shot-document'
import { FrameImageEditor } from '../image-edit/frame-image-editor'
import type { FrameEditTarget } from '../image-edit/image-edit-types'
import { aspectRatioStyle, isRunningStatus, SHOTS_PATH } from '../shots'
import { useShotGenerations } from '../storyboard.api'
import { useShotsDraft } from '../use-shots-draft'
import { useVideoGeneration } from '../use-video-generation'
import { ConflictDialog, ReaderNotice, SaveStatus } from './draft-status'
import { GenerationRecords } from './generation-records'
import { ReaderPage } from './reader-page'
import { shotContents } from '../shot-content'
import { PromptEditor } from './prompt-editor'
import { VideoGenerationButton } from './video-generation-button'

type ReaderSearch = {
  content?: string | undefined
  frame?: number | undefined
  sheet?: 'all' | 'prompt' | 'records' | undefined
  shot?: number | undefined
}
type Preview = (media: LightboxMedia, trigger: HTMLElement) => void

const pageOfScroll = (element: HTMLElement): number | undefined =>
  element.clientHeight > 0 ? Math.round(element.scrollTop / element.clientHeight) + 1 : undefined

export function StoryboardReader(props: ArtifactRendererProps) {
  const path = props.artifact.source.kind === 'file' ? props.artifact.source.path : SHOTS_PATH
  return <StoryboardWorkspace key={`${props.conversationId}:${path}`} {...props} />
}

function StoryboardWorkspace({ artifact, conversationId }: ArtifactRendererProps) {
  const path = artifact.source.kind === 'file' ? artifact.source.path : SHOTS_PATH
  const queryClient = useQueryClient()
  const [preparing, setPreparing] = useState(false)
  const prepareRef = useRef({ busy: false, mounted: true })
  useEffect(() => {
    const lifetime = prepareRef.current
    lifetime.mounted = true
    return () => {
      lifetime.mounted = false
    }
  }, [])
  const [uploadingGroups, setUploadingGroups] = useState<ReadonlySet<number>>(() => new Set())
  const onUploadingChange = useCallback((group: number, uploading: boolean) => {
    setUploadingGroups((current) => {
      if (current.has(group) === uploading) return current
      const next = new Set(current)
      if (uploading) next.add(group)
      else next.delete(group)
      return next
    })
  }, [])
  const file = useWorkspaceFile(conversationId, path)
  const generations = useShotGenerations(conversationId)
  const video = useVideoGeneration(conversationId)
  const [imageEditTarget, setImageEditTarget] = useState<FrameEditTarget | null>(null)
  const imageEditTriggerRef = useRef<HTMLElement | null>(null)
  const draft = useShotsDraft({ conversationId, path, file: file.data?.file })
  const [uploadedSources, setUploadedSources] = useState<
    { group: number; frame: number; url: string }[]
  >([])
  const savedContent = file.data?.file.content
  const savedDocument = useMemo(
    () => (savedContent === undefined ? null : parseShotsDocument(savedContent)),
    [savedContent],
  )
  // 根据已落盘地址判断上传是否仍未保存，避免一次较早请求成功就清除后来上传的提示。
  const appliedUpload =
    draft.hasUnsavedChanges &&
    uploadedSources.some(
      (source) =>
        draft.document?.shots.find((shot) => shot.index === source.group)?.image_urls[
          source.frame - 1
        ] === source.url &&
        savedDocument?.shots.find((shot) => shot.index === source.group)?.image_urls[
          source.frame - 1
        ] !== source.url,
    )
  const recordUpload = (group: number, frame: number, url: string) => {
    setUploadedSources((current) => [
      ...current.filter((source) => source.group !== group || source.frame !== frame),
      { group, frame, url },
    ])
  }
  const navigate = useNavigate()
  const search: ReaderSearch = useSearch({ strict: false })
  const pagesRef = useRef<HTMLDivElement | null>(null)
  const scrollTargetRef = useRef<number | null>(null)
  const sheetTriggerRef = useRef<HTMLElement | null>(null)
  const previewTriggerRef = useRef<HTMLElement | null>(null)
  const [media, setMedia] = useState<LightboxMedia | null>(null)
  const document = draft.document
  const shots = document?.shots ?? []
  const position =
    search.shot !== undefined && search.shot >= 1 && search.shot <= shots.length ? search.shot : 1

  const { clear: clearSelection, set: setSelection } = useWorkbenchSelection()
  const currentShot = shots[position - 1]
  const activeContents = currentShot === undefined ? [] : shotContents(currentShot)
  const activeContent =
    activeContents.find((item) => item.id === search.content) ?? activeContents[0]
  const selectedFrame =
    search.frame !== undefined && activeContent?.frameNumbers.includes(search.frame)
      ? search.frame
      : activeContent?.frameNumbers[0]
  const selectedContentId = activeContent?.id
  const selectedContentLabel =
    activeContent?.timelineIndex === undefined
      ? activeContent?.title
      : `镜头 ${activeContent.timelineIndex + 1}`
  useEffect(() => {
    if (selectedContentId === undefined) clearSelection()
    else {
      const label = selectedContentLabel
      const reference: WorkbenchRef = {
        id: `${artifact.id}:shot:${position}:${selectedContentId}:${selectedFrame ?? ''}`,
        label: `镜头组 ${position} · ${label}${selectedFrame === undefined ? '' : ` · @Image${selectedFrame}`}`,
        prefix: `针对镜头组 ${position} 的${label}${selectedFrame === undefined ? '' : `（参考图 @Image${selectedFrame}）`}：`,
      }
      setSelection([reference])
    }
  }, [
    selectedContentId,
    selectedContentLabel,
    artifact.id,
    clearSelection,
    position,
    selectedFrame,
    setSelection,
  ])
  useEffect(() => () => clearSelection(), [clearSelection])

  const go = (next: ReaderSearch) => {
    const cleared =
      next.shot !== undefined && next.shot !== position
        ? { content: undefined, frame: undefined }
        : {}
    void navigate({ replace: true, search: { ...search, ...cleared, ...next }, to: '.' })
  }

  const closeSheet = () => {
    go({ sheet: undefined })
    requestAnimationFrame(() => sheetTriggerRef.current?.focus())
  }

  const openSheet = (sheet: NonNullable<ReaderSearch['sheet']>, trigger: HTMLElement) => {
    sheetTriggerRef.current = trigger
    go({ sheet })
  }

  const preview: Preview = (next, trigger) => {
    previewTriggerRef.current = trigger
    setMedia(next)
  }

  const closePreview = () => {
    setMedia(null)
    requestAnimationFrame(() => previewTriggerRef.current?.focus())
  }

  useEffect(() => {
    const element = pagesRef.current
    if (element === null) return
    const showing = pageOfScroll(element)
    if (showing === undefined || showing === position) return
    scrollTargetRef.current = position
    const top = (position - 1) * element.clientHeight
    element.scrollTo({ behavior: 'instant', top })
    const frame = requestAnimationFrame(() => {
      if (element.scrollTop !== top) element.scrollTo({ behavior: 'instant', top })
    })
    return () => cancelAnimationFrame(frame)
  }, [position, shots.length])

  if (file.isPending && document === null) return <ReaderNotice text="正在读取分镜…" />
  if (file.isError && document === null) return <ReaderNotice text={file.error.message} />
  const shot = shots[position - 1]
  if (document === null || shot === undefined) {
    return <ReaderNotice text="文件格式不对，读不出镜头组" />
  }

  const jobs = generations.data?.items ?? []
  const activeCount = jobs.filter(
    (job) => job.kind === 'video' && job.shotIndex === shot.index && isRunningStatus(job.status),
  ).length
  // 出片发的是描述的当前版本；还在存或没存下就先别发，免得发出去的和文件里的不一样。
  // 原因不另写一句：左边的保存状态已经在说。
  const generateDisabled =
    preparing ||
    uploadingGroups.size > 0 ||
    draft.state.kind === 'conflict' ||
    video.options.model === undefined ||
    draft.state.kind === 'saving' ||
    draft.state.kind === 'error' ||
    video.submitting.includes(shot.index)
  const generate = async () => {
    if (prepareRef.current.busy || uploadingGroups.size > 0) return
    prepareRef.current.busy = true
    setPreparing(true)
    try {
      if (!(await draft.saveNow()) || !prepareRef.current.mounted) return
      const saved = queryClient.getQueryData<ConversationFileEnvelope>(
        workspaceQueryKeys.file(conversationId, path),
      )
      const document = saved === undefined ? null : parseShotsDocument(saved.file.content)
      const current = document?.shots.find((item) => item.index === shot.index)
      if (current === undefined || document === null) {
        toast.error('无法读取已保存的镜头组，请重新打开后生成')
        return
      }
      await video.submit(current, document.aspect_ratio)
    } finally {
      prepareRef.current.busy = false
      if (prepareRef.current.mounted) setPreparing(false)
    }
  }
  const onScroll = () => {
    const element = pagesRef.current
    if (element === null) return
    const showing = pageOfScroll(element)
    if (showing === undefined) return
    if (scrollTargetRef.current !== null) {
      if (showing !== scrollTargetRef.current) return
      scrollTargetRef.current = null
    }
    if (showing !== position) go({ shot: Math.min(Math.max(showing, 1), shots.length) })
  }

  return (
    <>
      <div
        className="flex min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden"
        inert={media !== null}
      >
        <div className="flex min-w-0 shrink-0 flex-wrap items-center justify-end gap-2 px-4 pt-2 pb-1">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            <SaveStatus
              state={draft.state}
              hasUnsavedChanges={draft.hasUnsavedChanges}
              appliedUpload={appliedUpload}
              onRetry={() => void draft.saveNow()}
            />
          </div>
          <Button
            aria-expanded={search.sheet === 'all'}
            onClick={(event) => openSheet('all', event.currentTarget)}
            size="md"
            variant="ghost"
          >
            全部镜头组
          </Button>
          <Button
            aria-expanded={search.sheet === 'records'}
            aria-label="生成记录"
            className="shrink-0 border-[0.5px] border-chat-hairline bg-background px-3 text-body text-on-surface"
            leadingIcon="history"
            onClick={(event) => openSheet('records', event.currentTarget)}
            size="md"
            variant="outlined"
          >
            生成记录
            {activeCount > 0 ? (
              <span className="ml-1 text-primary">生成中 {activeCount}</span>
            ) : null}
          </Button>
          <VideoGenerationButton
            disabled={generateDisabled}
            models={video.models}
            onChange={video.setOptions}
            onGenerate={() => void generate()}
            submitting={preparing || video.submitting.includes(shot.index)}
            unavailable={video.modelsUnavailable ? '视频模型读不到' : undefined}
            value={video.options}
          />
        </div>
        <div className="relative flex min-h-0 w-full min-w-0 flex-1 overflow-hidden">
          <div
            className="flex min-h-0 min-w-0 flex-1 snap-y snap-mandatory flex-col overflow-x-hidden overflow-y-auto [overflow-anchor:none]"
            inert={search.sheet !== undefined}
            onScroll={onScroll}
            ref={pagesRef}
          >
            {shots.map((item, offset) => (
              <ReaderPage
                aspect_ratio={document.aspect_ratio}
                onUpdateShot={(updater) => draft.updateShot(item.index, updater)}
                onReplaceFrame={(frame, previousUrl, url) => {
                  draft.replaceFrame(item.index, frame, previousUrl, url)
                  recordUpload(item.index, frame, url)
                }}
                onUploaded={(frame, url) => recordUpload(item.index, frame, url)}
                onUploadingChange={onUploadingChange}
                onEditFrame={(frame, sourceUrl) => {
                  imageEditTriggerRef.current =
                    window.document.activeElement instanceof HTMLElement
                      ? window.document.activeElement
                      : null
                  setImageEditTarget({
                    conversationId,
                    artifactPath: path,
                    shotIndex: item.index,
                    frameNumber: frame,
                    sourceUrl,
                  })
                }}
                content={offset + 1 === position ? search.content : undefined}
                frame={offset + 1 === position ? search.frame : undefined}
                key={`${item.index}-${offset + 1 === position ? 'active' : 'inactive'}`}
                onOpenPrompt={(trigger) => {
                  sheetTriggerRef.current = trigger
                  go({ sheet: 'prompt', shot: offset + 1 })
                }}
                onSelect={(content, frame) => go({ content, frame, shot: offset + 1 })}
                onPreview={preview}
                shot={item}
              />
            ))}
          </div>
          <nav
            aria-label="镜头组页码"
            className="flex shrink-0 flex-col items-center justify-center gap-2 px-2"
            inert={search.sheet !== undefined}
          >
            {shots.map((item) => (
              <button
                aria-current={item.index === shot.index}
                aria-label={`第 ${item.index} 组`}
                className={cn(
                  'size-1.5 cursor-pointer rounded-full ui-focus ui-motion-s',
                  item.index === shot.index ? 'bg-on-surface' : 'bg-outline-variant',
                )}
                key={item.index}
                onClick={() => go({ shot: item.index })}
                onKeyDown={(event) => {
                  const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0
                  const next = position + step
                  if (step === 0 || next < 1 || next > shots.length) return
                  event.preventDefault()
                  go({ shot: next })
                }}
                type="button"
              />
            ))}
          </nav>
          {search.sheet === 'prompt' ? (
            <ReaderOverlay label="镜头组完整提示词" onClose={closeSheet}>
              <PromptReading
                aspect_ratio={document.aspect_ratio}
                onClose={closeSheet}
                onPreview={preview}
                onChangeGlobalSettings={(text) =>
                  draft.updateShot(shot.index, (current) => ({
                    ...current,
                    prompt: { ...current.prompt, global_settings: text },
                  }))
                }
                shot={shot}
              />
            </ReaderOverlay>
          ) : null}
          {search.sheet === 'all' ? (
            <ReaderOverlay label="全部镜头组" onClose={closeSheet}>
              <ShotOverview
                shots={shots}
                aspect_ratio={document.aspect_ratio}
                onClose={closeSheet}
                onOpenShot={(index) => go({ sheet: undefined, shot: index })}
              />
            </ReaderOverlay>
          ) : null}
          {search.sheet === 'records' ? (
            <ReaderOverlay
              className="left-auto w-full max-w-100"
              label="生成记录"
              onClose={closeSheet}
            >
              {generations.isError ? (
                <>
                  <Button onClick={closeSheet} size="md" variant="ghost">
                    关闭生成记录
                  </Button>
                  <ReaderNotice text={generations.error.message} />
                </>
              ) : generations.isPending ? (
                <>
                  <Button onClick={closeSheet} size="md" variant="ghost">
                    关闭生成记录
                  </Button>
                  <ReaderNotice text="正在读取生成记录…" />
                </>
              ) : (
                <GenerationRecords
                  jobs={jobs}
                  onClose={closeSheet}
                  onEditPrompt={(prompt) => {
                    const problem = validateShot({ ...shot, prompt })
                    if (problem !== undefined) {
                      toast.error(problem)
                      return
                    }
                    draft.updateShot(shot.index, (current) => ({ ...current, prompt }))
                    closeSheet()
                    toast('历史提示词已回填到当前镜头组')
                  }}
                  shotIndex={shot.index}
                />
              )}
            </ReaderOverlay>
          ) : null}
        </div>
      </div>
      <MediaLightbox media={media} onClose={closePreview} />
      {imageEditTarget === null ? null : (
        <FrameImageEditor
          key={JSON.stringify(imageEditTarget)}
          target={imageEditTarget}
          frames={shots.find((item) => item.index === imageEditTarget.shotIndex)?.image_urls ?? []}
          aspectRatio={document.aspect_ratio}
          onClose={() => {
            setImageEditTarget(null)
            requestAnimationFrame(() => imageEditTriggerRef.current?.focus())
          }}
          onApply={(url) =>
            draft.applyFrame(
              imageEditTarget.shotIndex,
              imageEditTarget.frameNumber,
              imageEditTarget.sourceUrl,
              url,
            )
          }
        />
      )}
      <ConflictDialog
        state={draft.state}
        resolve={(choice) => {
          draft.resolveConflict(choice)
          if (choice === 'theirs') setUploadedSources([])
        }}
      />
    </>
  )
}

type ReaderOverlayProps = {
  label: string
  children: ReactNode
  onClose: () => void
  className?: string
}

function ReaderOverlay({ children, className, label, onClose }: ReaderOverlayProps) {
  const ref = useRef<HTMLElement | null>(null)
  useEffect(() => {
    const target =
      ref.current?.querySelector<HTMLElement>('[data-reader-focus]') ??
      ref.current?.querySelector<HTMLElement>('button')
    target?.focus()
  }, [])
  // 监听只挂一次。跟着 onClose 重挂会排到预览弹层的监听之后：弹层先关、焦点回到抽屉里，
  // 这里再看到的就是「没有弹层、焦点在抽屉内」，会把抽屉也一起关掉。
  const close = useEffectEvent(onClose)
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (
        event.key !== 'Escape' ||
        event.defaultPrevented ||
        document.querySelector('[aria-modal="true"]') !== null ||
        !ref.current?.contains(document.activeElement)
      )
        return
      event.preventDefault()
      close()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [])
  return (
    <aside
      aria-label={label}
      className={cn(
        'group-prompt-sheet absolute inset-0 flex min-h-0 min-w-0 animate-in flex-col overflow-hidden rounded-t-lg border-[0.5px] border-chat-hairline bg-background shadow-[var(--shadow-2)] duration-(--dur-m) ease-(--ease-decel) slide-in-from-bottom motion-reduce:animate-none',
        className,
      )}
      ref={ref}
    >
      {children}
    </aside>
  )
}

type PromptReadingProps = {
  shot: Shot
  aspect_ratio: string
  onClose: () => void
  onPreview: Preview
  onChangeGlobalSettings: (text: string) => void
}

function PromptReading({
  aspect_ratio,
  onClose,
  onPreview,
  onChangeGlobalSettings,
  shot,
}: PromptReadingProps) {
  return (
    <>
      <header className="flex shrink-0 items-center justify-between gap-3 border-b-[0.5px] border-chat-hairline px-5 py-4">
        <div>
          <h3 className="text-body font-medium text-on-surface">
            镜头组 {shot.index} · 完整提示词
          </h3>
          <p className="mt-1 text-body-sm text-on-surface-faint">
            {shot.seconds} 秒 · {aspect_ratio} · {shot.image_urls.length} 张参考图
          </p>
        </div>
        <Button
          aria-label="收起完整提示词"
          onClick={onClose}
          size="md"
          trailingIcon="expand"
          variant="ghost"
        >
          收起
        </Button>
      </header>
      <div className="group-prompt-body min-h-0 flex-1">
        <div
          aria-label="镜头组原文"
          className="group-prompt-reading min-h-0 min-w-0 space-y-5 overflow-y-auto overscroll-contain p-5 ui-focus-inline"
          data-reader-focus
          role="region"
          tabIndex={-1}
        >
          <PromptEditor
            aria-label="全局设定"
            frames={shot.image_urls}
            onChange={onChangeGlobalSettings}
            value={shot.prompt.global_settings}
            onPickFrame={(number) => {
              const url = shot.image_urls[number - 1]
              if (url !== undefined)
                onPreview(
                  { kind: 'image', name: `参考图 @Image${number}`, url },
                  window.document.activeElement instanceof HTMLElement
                    ? window.document.activeElement
                    : window.document.body,
                )
            }}
          />
          {shot.prompt.timeline.map((item, index) => (
            <section aria-label={`镜头 ${index + 1} 原文`} key={item.timestamps.join(':')}>
              <h4 className="mb-2 text-label text-on-surface-faint">
                [{item.timestamps[0]}–{item.timestamps[1]}秒｜镜头{index + 1}]
              </h4>
              <p className="text-body leading-relaxed wrap-anywhere whitespace-pre-wrap text-on-surface">
                {item.prompt}
              </p>
            </section>
          ))}
        </div>
        <section
          aria-label="本组参考图"
          className="group-prompt-references min-h-0 min-w-0 overflow-y-auto overscroll-contain border-l-[0.5px] border-chat-hairline p-4"
        >
          <h4 className="mb-3 text-body-sm font-medium text-on-surface-variant">
            参考图 · {shot.image_urls.length} 张
          </h4>
          {shot.image_urls.length === 0 ? (
            <p className="text-body-sm text-on-surface-faint">本组暂无参考图</p>
          ) : (
            <div className="grid grid-cols-2 items-start gap-x-3 gap-y-4">
              {shot.image_urls
                .map((url, index) => ({ url, number: index + 1 }))
                .map(({ url, number }) => (
                  <figure className="min-w-0" key={number}>
                    <button
                      aria-label={`查看参考图 @Image${number}`}
                      className="block w-full cursor-zoom-in overflow-hidden rounded-xs bg-surface-container ui-focus"
                      onClick={(event) =>
                        onPreview(
                          { kind: 'image', name: `参考图 @Image${number}`, url },
                          event.currentTarget,
                        )
                      }
                      type="button"
                    >
                      <img
                        alt={`镜头组 ${shot.index} 参考图 @Image${number}`}
                        className="block w-full object-contain"
                        loading="lazy"
                        src={url}
                        style={{ aspectRatio: aspectRatioStyle(aspect_ratio) }}
                      />
                    </button>
                    <figcaption className="mt-1 text-caption text-on-surface-variant">
                      @Image{number}
                    </figcaption>
                  </figure>
                ))}
            </div>
          )}
        </section>
      </div>
      <footer className="flex shrink-0 justify-end border-t-[0.5px] border-chat-hairline px-5 py-3">
        <Button
          leadingIcon="copy"
          onClick={() => void copyText(formatShotPrompt(shot), '已复制完整提示词')}
          size="md"
          variant="ghost"
        >
          复制完整提示词
        </Button>
      </footer>
    </>
  )
}

const copyText = async (text: string, message: string) => {
  try {
    await writeClipboard(text)
    toast(message)
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '复制失败')
  }
}

type ShotOverviewProps = {
  shots: readonly Shot[]
  aspect_ratio: string
  onClose: () => void
  onOpenShot: (index: number) => void
}

function ShotOverview({ shots, aspect_ratio, onClose, onOpenShot }: ShotOverviewProps) {
  const [selected, setSelected] = useState<readonly number[]>([])
  const chosen = shots.filter((shot) => selected.includes(shot.index))
  const all = chosen.length === shots.length
  return (
    <>
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b-[0.5px] border-chat-hairline px-4 py-3">
        <h3 className="text-body font-medium text-on-surface">全部镜头组</h3>
        <Button
          onClick={() => setSelected(all ? [] : shots.map((shot) => shot.index))}
          size="md"
          variant="ghost"
        >
          {all ? '取消全选' : '全选'}
        </Button>
        <span className="text-body-sm text-on-surface-faint">已选 {chosen.length} 个</span>
        <span className="flex-1" />
        <Button
          disabled={chosen.length === 0}
          leadingIcon="copy"
          onClick={() =>
            void copyText(formatShotPrompts(chosen), `已复制 ${chosen.length} 个镜头组`)
          }
          size="md"
          variant="ghost"
        >
          复制选中镜头组
        </Button>
        <IconButton label="关闭全部镜头组" name="close" onClick={onClose} size="sm" />
      </header>
      <ul className="grid min-h-0 flex-1 grid-cols-[repeat(auto-fill,minmax(150px,1fr))] content-start gap-3 overflow-y-auto p-4">
        {shots.map((shot) => {
          const number =
            shot.prompt.timeline[0]?.image_indexes.find(
              (value) => value >= 1 && value <= shot.image_urls.length,
            ) ?? 1
          const url = shot.image_urls[number - 1]
          const picked = selected.includes(shot.index)
          return (
            <li className="relative" key={shot.index}>
              <button
                aria-label={`查看镜头组 ${shot.index}`}
                className="block w-full cursor-pointer overflow-hidden rounded-md border-[0.5px] border-chat-hairline bg-chat-card-bg text-left ui-focus"
                onClick={() => onOpenShot(shot.index)}
                type="button"
              >
                <span
                  className="grid w-full place-items-center bg-surface-container"
                  style={{ aspectRatio: aspectRatioStyle(aspect_ratio) }}
                >
                  {url === undefined ? (
                    <span className="text-body-sm text-on-surface-faint">无图</span>
                  ) : (
                    <img
                      alt={`镜头组 ${shot.index} 首帧`}
                      className="size-full object-cover"
                      src={url}
                    />
                  )}
                </span>
                <span className="flex min-w-0 flex-col gap-1 px-3 py-2">
                  <span className="text-label text-on-surface-faint">
                    第 {shot.index} 组 · {shot.seconds} 秒
                  </span>
                  <span className="truncate text-body-sm text-on-surface">{shotName(shot)}</span>
                </span>
              </button>
              <button
                aria-label={`选中镜头组 ${shot.index}`}
                aria-pressed={picked}
                className={cn(
                  'absolute top-2 right-2 grid size-6 cursor-pointer place-items-center rounded-full border-[0.5px] border-chat-hairline ui-focus',
                  picked ? 'bg-primary text-on-primary' : 'bg-chat-card-bg text-transparent',
                )}
                onClick={() =>
                  setSelected((current) =>
                    current.includes(shot.index)
                      ? current.filter((index) => index !== shot.index)
                      : [...current, shot.index],
                  )
                }
                type="button"
              >
                <Icon decorative name="check" size="xs" />
              </button>
            </li>
          )
        })}
      </ul>
    </>
  )
}
