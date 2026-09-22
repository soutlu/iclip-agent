/** 结构化分镜工作台；查询参数保存组与帧位置，草稿局部更新后整份保存。 */

import { useNavigate, useSearch } from '@tanstack/react-router'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ASPECT_RATIOS } from '@/shared/lib/aspect-ratio'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { Select } from '@/shared/ui/field'
import { MediaLightbox, type LightboxMedia } from '@/shared/ui/media-lightbox'
import { toast } from '@/shared/ui/toast'
import {
  useWorkbenchSelection,
  useWorkspaceFile,
  type ArtifactRendererProps,
  type WorkbenchRef,
} from '@/shared/workbench'
import { parseShotsDocument, validateShot } from '../shot-document'
import { frameBadges, latestFrameJobs } from '../frame-status'
import { readStoryboardMetadata } from '../generation-metadata'
import { useFrameImageJobs } from '../image-edit/image-edit.api'
import { isRunningStatus, SHOTS_PATH } from '../shots'
import { useShotGenerations } from '../storyboard.api'
import { useGenerationGate } from '../use-generation-gate'
import { supportsAspectRatio } from '../video-model-support'
import { useShotsDraft } from '../use-shots-draft'
import { useLiveGenerations } from '../use-live-generations'
import { useVideoGeneration } from '../use-video-generation'
import { editCountsByRoot } from '../video-editor/edit-chain'
import { VideoEditor } from '../video-editor/video-editor'
import { ConflictDialog, ReaderNotice, SaveStatus } from './draft-status'
import { GenerationRecords } from './generation-records'
import { PromptReading } from './prompt-reading'
import { ReaderImageEdit, type FrameEditSession } from './reader-image-edit'
import { ReaderOverlay } from './reader-overlay'
import { ReaderPage } from './reader-page'
import { shotContents } from '../shot-content'
import { ShotOverview } from './shot-overview'
import { VideoGenerationButton } from './video-generation-button'

type ReaderSearch = {
  content?: string | undefined
  frame?: number | undefined
  sheet?: 'all' | 'prompt' | 'records' | undefined
  shot?: number | undefined
  /** 视频编辑器开在哪条出片记录上；换组就关掉。 */
  video?: string | undefined
}
const pageOfScroll = (element: HTMLElement): number | undefined =>
  element.clientHeight > 0 ? Math.round(element.scrollTop / element.clientHeight) + 1 : undefined

export function StoryboardReader(props: ArtifactRendererProps) {
  const path = props.artifact.source.kind === 'file' ? props.artifact.source.path : SHOTS_PATH
  return <StoryboardWorkspace key={`${props.conversationId}:${path}`} {...props} />
}

function StoryboardWorkspace({ artifact, conversationId, readOnly }: ArtifactRendererProps) {
  const path = artifact.source.kind === 'file' ? artifact.source.path : SHOTS_PATH
  const gate = useGenerationGate()
  const file = useWorkspaceFile(conversationId, path)
  const generations = useShotGenerations(conversationId)
  const frameJobs = useFrameImageJobs(conversationId)
  useLiveGenerations(conversationId)
  // 关过编辑器就算看过那一格的终态；只记本次会话，刷新后没看过的终态会再出现一次。
  const [seenFrameJobs, setSeenFrameJobs] = useState<ReadonlySet<string>>(() => new Set())
  const video = useVideoGeneration(conversationId)
  // 打开时先选中哪一条、从哪个控件点开都由入口决定。
  const [imageEdit, setImageEdit] = useState<FrameEditSession | null>(null)
  const draft = useShotsDraft({ conversationId, path, file: file.data?.file })
  const [uploadedSources, setUploadedSources] = useState<
    { group: number; frame: number; url: string }[]
  >([])
  const savedContent = file.data?.file.content
  const savedDocument = useMemo(
    () => (savedContent === undefined ? null : parseShotsDocument(savedContent)),
    [savedContent],
  )
  const latestFrameJob = useMemo(
    () => latestFrameJobs(frameJobs.data?.items ?? []),
    [frameJobs.data],
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
        ? { content: undefined, frame: undefined, video: undefined }
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

  // 本对话全部出片记录，按镜头组挑格子的事交给各消费方——它们都自己读坐标。
  const jobs = generations.data?.items ?? []
  // 编辑结果不带分镜坐标，抽屉里不单列；数一下折进原片那张卡。
  const editCounts = editCountsByRoot(jobs)
  const videoEditRoot =
    search.video === undefined ? undefined : jobs.find((job) => job.id === search.video)
  const activeCount = jobs.filter(
    (job) =>
      job.kind === 'video' &&
      readStoryboardMetadata(job)?.shot === shot.index &&
      isRunningStatus(job.status),
  ).length
  // 出片发的是描述的当前版本；还在存或没存下就先别发，免得发出去的和文件里的不一样。
  // 原因不另写一句：左边的保存状态已经在说。只读时整页的编辑与生成入口一起收起。
  const editingDisabled = readOnly || gate.preparing
  const generateDisabled =
    readOnly ||
    gate.preparing ||
    gate.uploading ||
    draft.state.kind === 'conflict' ||
    video.options.model === undefined ||
    draft.state.kind === 'saving' ||
    draft.state.kind === 'error' ||
    video.submitting.includes(shot.index)
  // 改过之后原因就过期了，等下一次出片再说；存盘状态那一格有自己的提示，不重复说。
  const submitError = draft.hasUnsavedChanges ? undefined : video.errorOf(shot.index)
  // 选中的模型做不了这份分镜的画幅：只提醒，不拦——真拒还是由上游拒（ADR-0018）。
  const aspectMismatch = supportsAspectRatio(video.options.model, document.aspect_ratio)
    ? undefined
    : `${video.options.model} 做不了 ${document.aspect_ratio}`
  const generateNotice = submitError ?? aspectMismatch
  const generate = () =>
    gate.run(async (mounted) => {
      const saved = await draft.saveNow()
      if (saved === null || !mounted()) return
      const current = saved.shots.find((item) => item.index === shot.index)
      if (current === undefined) {
        video.reportError(shot.index, '无法读取已保存的镜头组，请重新打开后生成')
        return
      }
      await video.submit(current, saved.aspect_ratio)
    })
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
      <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden">
        <div
          aria-label="出片工具栏"
          className="flex min-w-0 shrink-0 flex-wrap items-center justify-end gap-2 px-4 pt-2 pb-1"
          role="group"
        >
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            <Select
              aria-label="画幅"
              disabled={editingDisabled}
              onChange={(event) => draft.updateAspectRatio(event.target.value)}
              value={document.aspect_ratio}
              variant="inline"
            >
              {/* agent 可以写任何 宽:高，不在档位里的也要照原样显示得出来。 */}
              {ASPECT_RATIOS.some((ratio) => ratio === document.aspect_ratio) ? null : (
                <option value={document.aspect_ratio}>{document.aspect_ratio}</option>
              )}
              {ASPECT_RATIOS.map((ratio) => {
                const usable = supportsAspectRatio(video.options.model, ratio)
                // 选中的那个不加后缀：收起来的下拉只显示它，长文案会把顶栏挤下去；
                // 它正好不被支持时，出片按钮旁边那句提示已经在说了。
                const label =
                  usable || ratio === document.aspect_ratio ? ratio : `${ratio}（不支持）`
                return (
                  <option disabled={!usable} key={ratio} value={ratio}>
                    {label}
                  </option>
                )
              })}
            </Select>
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
          {generateNotice === undefined ? null : (
            <span
              className="min-w-0 shrink truncate text-body-sm text-error"
              role="alert"
              title={generateNotice}
            >
              {generateNotice}
            </span>
          )}
          <VideoGenerationButton
            disabled={generateDisabled}
            models={video.models}
            onChange={video.setOptions}
            onGenerate={() => void generate()}
            submitting={gate.preparing || video.submitting.includes(shot.index)}
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
                editingDisabled={editingDisabled}
                aspect_ratio={document.aspect_ratio}
                onUpdateShot={(updater) => draft.updateShot(item.index, updater)}
                onReplaceFrame={(frame, previousUrl, url) => {
                  draft.replaceFrame(item.index, frame, previousUrl, url)
                  recordUpload(item.index, frame, url)
                }}
                onUploaded={(frame, url) => recordUpload(item.index, frame, url)}
                onUploadingChange={gate.onUploadingChange}
                onEditFrame={(frame, open) => {
                  setImageEdit({
                    target: { conversationId, shotIndex: item.index, frameNumber: frame },
                    ...(open.kind === 'result' ? { initialKey: open.jobId } : {}),
                    trigger:
                      window.document.activeElement instanceof HTMLElement
                        ? window.document.activeElement
                        : null,
                  })
                }}
                content={offset + 1 === position ? search.content : undefined}
                frame={offset + 1 === position ? search.frame : undefined}
                frameBadges={frameBadges(item, latestFrameJob, seenFrameJobs)}
                key={`${item.index}-${offset + 1 === position ? 'active' : 'inactive'}`}
                onOpenPrompt={(trigger) => {
                  sheetTriggerRef.current = trigger
                  go({ sheet: 'prompt', shot: offset + 1 })
                }}
                onSelect={(content, frame) => go({ content, frame, shot: offset + 1 })}
                onPreview={setMedia}
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
                onPreview={setMedia}
                onUpdateShot={(updater) => draft.updateShot(shot.index, updater)}
                readOnly={editingDisabled}
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
                  editCounts={editCounts}
                  jobs={jobs}
                  onClose={closeSheet}
                  onEditVideo={readOnly ? undefined : (job) => go({ video: job.id })}
                  onEditPrompt={
                    readOnly
                      ? undefined
                      : (prompt) => {
                          const problem = validateShot({ ...shot, prompt })
                          if (problem !== undefined) {
                            toast.error(problem)
                            return
                          }
                          draft.updateShot(shot.index, (current) => ({ ...current, prompt }))
                          closeSheet()
                          toast('历史提示词已回填到当前镜头组')
                        }
                  }
                  shotIndex={shot.index}
                />
              )}
            </ReaderOverlay>
          ) : null}
        </div>
      </div>
      <MediaLightbox media={media} onClose={() => setMedia(null)} />
      {search.video === undefined ? null : (
        <VideoEditor
          conversationId={conversationId}
          loading={generations.isPending}
          onClose={() => go({ video: undefined })}
          root={videoEditRoot}
          shotIndex={
            videoEditRoot === undefined ? undefined : readStoryboardMetadata(videoEditRoot)?.shot
          }
        />
      )}
      {imageEdit === null ? null : (
        <ReaderImageEdit
          aspectRatio={document.aspect_ratio}
          frames={shots.find((item) => item.index === imageEdit.target.shotIndex)?.image_urls ?? []}
          latestFrameJobs={latestFrameJob}
          onApply={(previousUrl, url) =>
            draft.applyFrame(
              imageEdit.target.shotIndex,
              imageEdit.target.frameNumber,
              previousUrl,
              url,
            )
          }
          onClose={(seen) => {
            if (seen !== undefined) setSeenFrameJobs((current) => new Set(current).add(seen.id))
            setImageEdit(null)
          }}
          session={imageEdit}
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
