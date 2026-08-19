import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  createVideoBatchKey,
  formatVideoBatchSecond,
} from '@/features/artifacts/renderers/video-batch-prompt.utils'
import type { VideoPromptPreviewImage } from '@/features/artifacts/types/video-prompt.types'
import { cn } from '@/shared/lib/utils'
import { MediaPreviewDialog, useMediaPreview } from '@/shared/ui/media'
import {
  createVideoGenerationInput,
  createVideoGenerationStatusByPromptIndex,
  createVideoGenerationSubmissionItems,
  createVideoPromptDrafts,
  formatVideoBatchIndex,
  getVideoGenerationAllButtonLabel,
  getVideoGenerationButtonLabel,
  getVideoGenerationStatusBlocker,
  getVideoGenerationStatusDisplayLabel,
  getVideoGenerationSubmitBlocker,
  getVideoPromptDraft,
  ICON_ACTION_BUTTON_CLASS,
  isPendingGeneratedVideoStatus,
  PROMPT_EDIT_BUTTON_CLASS,
  resolveInitialVideoBatchKey,
  resolveSelectedVideoBatch,
  stopActionPropagation,
  VIDEO_PROMPT_DISABLED_BUTTON_CLASS,
  VIDEO_PROMPT_PRIMARY_BUTTON_BASE_CLASS,
  VIDEO_PROMPT_PRIMARY_BUTTON_ENABLED_CLASS,
  VIDEO_PROMPT_SECONDARY_BUTTON_BASE_CLASS,
  VIDEO_PROMPT_SECONDARY_BUTTON_ENABLED_CLASS,
  type VideoPromptCanvasCardProps,
  videoPromptPreviewImageToPreviewItem,
  type VideoPromptSaveCandidate,
  writeTextToClipboard,
} from './video-prompt-canvas-card.utils'
import {
  CheckIcon,
  CopyIcon,
  PencilIcon,
  VideoPromptReadingView,
} from './VideoPromptCanvasCardParts'

/**
 * 渲染视频提示词 artifact 卡片。
 *
 * @param props - 视频提示词卡片属性。
 * @param props.generatedVideo - 当前项目已有的视频生成任务状态，用于阻止重复提交。
 * @param props.isVideoGenerationDisabled - 当前项目运行态是否禁止提交视频生成任务。
 * @param props.onSubmitVideoGenerations - 提交全部镜头视频生成任务的回调。
 * @param props.onSubmitVideoGeneration - 提交当前镜头视频生成任务的回调。
 * @param props.videoPrompt - 后端 AG-UI state 返回的视频提示词结果。
 * @returns 视频提示词展示卡片。
 */
export default function VideoPromptCanvasCard({
  generatedVideo,
  isVideoGenerationDisabled = false,
  onSavePrompt,
  onSubmitVideoGenerations,
  onSubmitVideoGeneration,
  videoPrompt,
}: VideoPromptCanvasCardProps) {
  const [copiedBatchKey, setCopiedBatchKey] = useState<string | null>(null)
  const [editingBatchKey, setEditingBatchKey] = useState<string | null>(null)
  const [isSavingPrompt, setIsSavingPrompt] = useState(false)
  const [isSubmittingAllBatches, setIsSubmittingAllBatches] = useState(false)
  const [promptSaveErrorMessage, setPromptSaveErrorMessage] = useState<string | null>(null)
  const [promptDrafts, setPromptDrafts] = useState<Record<string, string>>(() =>
    createVideoPromptDrafts(videoPrompt.batches),
  )
  const [selectedBatchKey, setSelectedBatchKey] = useState<string | null>(() =>
    resolveInitialVideoBatchKey(videoPrompt.batches),
  )
  const [submittedBatchKeys, setSubmittedBatchKeys] = useState<ReadonlySet<string>>(() => new Set())
  const [submittingBatchKey, setSubmittingBatchKey] = useState<string | null>(null)
  const { closePreview, openPreview, preview } = useMediaPreview()
  const copyTimeoutRef = useRef<ReturnType<typeof globalThis.setTimeout> | null>(null)
  const selectedBatch = resolveSelectedVideoBatch(videoPrompt.batches, selectedBatchKey)
  const selectedBatchLabel = selectedBatch ? formatVideoBatchIndex(selectedBatch) : '01'
  const selectedBatchSecond = selectedBatch ? formatVideoBatchSecond(selectedBatch.second) : null
  const selectedBatchKeyResolved = selectedBatch ? createVideoBatchKey(selectedBatch) : null
  const selectedReferenceImageCount = selectedBatch?.previewImages?.length ?? 0
  const selectedPromptDraft = selectedBatch ? getVideoPromptDraft(selectedBatch, promptDrafts) : ''
  const isEditingSelectedBatch =
    selectedBatchKeyResolved !== null && editingBatchKey === selectedBatchKeyResolved
  const selectedPromptReadingText = selectedPromptDraft.trim()
  const generatedVideoStatusByPromptIndex = useMemo(
    () => createVideoGenerationStatusByPromptIndex(generatedVideo),
    [generatedVideo],
  )
  const selectedGenerationStatus = selectedBatch
    ? (generatedVideoStatusByPromptIndex.get(selectedBatch.index) ?? null)
    : null
  const selectedSubmittedBlocker =
    selectedBatchKeyResolved && submittedBatchKeys.has(selectedBatchKeyResolved)
      ? '当前镜头已提交，等待状态刷新。'
      : null
  const allGenerationSubmission = useMemo(
    () =>
      createVideoGenerationSubmissionItems({
        aspectRatio: videoPrompt.aspectRatio,
        batches: videoPrompt.batches,
        generatedVideoStatusByPromptIndex,
        promptDrafts,
        submittedBatchKeys,
      }),
    [
      generatedVideoStatusByPromptIndex,
      promptDrafts,
      submittedBatchKeys,
      videoPrompt.aspectRatio,
      videoPrompt.batches,
    ],
  )
  const isAllBatchesSubmitted =
    videoPrompt.batches.length > 0 &&
    videoPrompt.batches.every((batch) => {
      const batchGenerationStatus = generatedVideoStatusByPromptIndex.get(batch.index)

      return (
        submittedBatchKeys.has(createVideoBatchKey(batch)) ||
        (batchGenerationStatus ? isPendingGeneratedVideoStatus(batchGenerationStatus) : false)
      )
    })
  const selectedFieldBlocker = selectedBatch
    ? getVideoGenerationSubmitBlocker({
        aspectRatio: videoPrompt.aspectRatio,
        prompt: selectedPromptDraft,
        seconds: selectedBatch.second,
      })
    : '当前没有可提交的视频镜头。'
  const submitBlocker =
    (selectedGenerationStatus ? getVideoGenerationStatusBlocker(selectedGenerationStatus) : null) ??
    selectedSubmittedBlocker ??
    selectedFieldBlocker
  const selectedSubmitBlockerText = submitBlocker
    ? `镜头 ${selectedBatchLabel}：${submitBlocker}`
    : null
  const generationFeedback = selectedSubmitBlockerText ?? allGenerationSubmission.blocker
  const isSubmittingSelectedBatch =
    selectedBatchKeyResolved !== null &&
    (submittingBatchKey === selectedBatchKeyResolved || isSubmittingAllBatches)
  const canSubmitSelectedBatch =
    !!onSubmitVideoGeneration &&
    selectedBatchKeyResolved !== null &&
    !submittedBatchKeys.has(selectedBatchKeyResolved) &&
    !isVideoGenerationDisabled &&
    !isSavingPrompt &&
    !isSubmittingAllBatches &&
    !isSubmittingSelectedBatch &&
    !submitBlocker
  const canSubmitAllBatches =
    !!onSubmitVideoGenerations &&
    !isVideoGenerationDisabled &&
    !isSavingPrompt &&
    !isSubmittingAllBatches &&
    submittingBatchKey === null &&
    !allGenerationSubmission.blocker

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current !== null) {
        globalThis.clearTimeout(copyTimeoutRef.current)
      }
    }
  }, [])

  useEffect(() => {
    const nextSelectedBatch = resolveSelectedVideoBatch(videoPrompt.batches, selectedBatchKey)
    const nextSelectedBatchKey = nextSelectedBatch ? createVideoBatchKey(nextSelectedBatch) : null

    if (nextSelectedBatchKey !== selectedBatchKey) {
      setSelectedBatchKey(nextSelectedBatchKey)
    }
  }, [selectedBatchKey, videoPrompt.batches])

  useEffect(() => {
    const nextBatchKeys = new Set(videoPrompt.batches.map((batch) => createVideoBatchKey(batch)))

    setPromptDrafts(createVideoPromptDrafts(videoPrompt.batches))
    setEditingBatchKey((currentBatchKey) =>
      currentBatchKey && nextBatchKeys.has(currentBatchKey) ? currentBatchKey : null,
    )
    setPromptSaveErrorMessage(null)
    setSubmittedBatchKeys(new Set())
    setSubmittingBatchKey(null)
  }, [videoPrompt.batches])

  useEffect(() => {
    const backendPromptIndexes = new Set<number>()

    for (const video of generatedVideo?.videos ?? []) {
      if (typeof video.promptIndex === 'number' && Number.isFinite(video.promptIndex)) {
        backendPromptIndexes.add(video.promptIndex)
      }
    }

    if (backendPromptIndexes.size === 0) {
      return
    }

    setSubmittedBatchKeys((currentBatchKeys) => {
      let nextBatchKeys: Set<string> | null = null

      for (const batch of videoPrompt.batches) {
        const batchKey = createVideoBatchKey(batch)

        if (currentBatchKeys.has(batchKey) && backendPromptIndexes.has(batch.index)) {
          nextBatchKeys ??= new Set(currentBatchKeys)
          nextBatchKeys.delete(batchKey)
        }
      }

      return nextBatchKeys ?? currentBatchKeys
    })
  }, [generatedVideo, videoPrompt.batches])

  /**
   * 更新当前选中镜头的提示词草稿。
   *
   * @param batchKey - 当前镜头的稳定 key。
   * @param prompt - 用户在文本框中输入的新提示词。
   */
  const updatePromptDraft = useCallback((batchKey: string, prompt: string) => {
    setPromptSaveErrorMessage(null)
    setPromptDrafts((currentDrafts) => ({
      ...currentDrafts,
      [batchKey]: prompt,
    }))
  }, [])

  const savePromptCandidates = useCallback(
    async (candidates: VideoPromptSaveCandidate[]) => {
      for (const candidate of candidates) {
        if (candidate.prompt.trim().length === 0) {
          setPromptSaveErrorMessage('提示词不能为空。')
          return false
        }
      }

      const changedCandidates = candidates.filter(
        (candidate) => candidate.prompt.trim() !== candidate.originalPrompt.trim(),
      )

      if (changedCandidates.length === 0) {
        setPromptSaveErrorMessage(null)
        setEditingBatchKey(null)
        return true
      }

      try {
        setIsSavingPrompt(true)
        setPromptSaveErrorMessage(null)

        for (const candidate of changedCandidates) {
          await onSavePrompt({
            prompt: candidate.prompt.trim(),
            shotIndex: candidate.shotIndex,
          })
        }

        setEditingBatchKey(null)
        return true
      } catch (error) {
        setPromptSaveErrorMessage(error instanceof Error ? error.message : '保存提示词失败。')
        return false
      } finally {
        setIsSavingPrompt(false)
      }
    },
    [onSavePrompt],
  )

  const handlePromptEditAction = useCallback(async () => {
    if (!selectedBatch || !selectedBatchKeyResolved) {
      return
    }

    if (!isEditingSelectedBatch) {
      setPromptSaveErrorMessage(null)
      setEditingBatchKey(selectedBatchKeyResolved)
      return
    }

    await savePromptCandidates([
      {
        originalPrompt: selectedBatch.prompt,
        prompt: selectedPromptDraft,
        shotIndex: selectedBatch.index,
      },
    ])
  }, [
    isEditingSelectedBatch,
    savePromptCandidates,
    selectedBatch,
    selectedBatchKeyResolved,
    selectedPromptDraft,
  ])

  /**
   * 复制指定镜头提示词，并短暂切换按钮状态。
   *
   * @param batchKey - 当前镜头的稳定 key。
   * @param prompt - 需要写入剪贴板的提示词。
   */
  const handleCopyPrompt = useCallback(async (batchKey: string, prompt: string) => {
    const didCopy = await writeTextToClipboard(prompt)

    if (didCopy) {
      setCopiedBatchKey(batchKey)

      if (copyTimeoutRef.current !== null) {
        globalThis.clearTimeout(copyTimeoutRef.current)
      }

      copyTimeoutRef.current = globalThis.setTimeout(() => {
        setCopiedBatchKey(null)
        copyTimeoutRef.current = null
      }, 1500)
      return
    }

    setCopiedBatchKey(null)
  }, [])

  const handleReferenceImagePreviewOpen = useCallback(
    (image: VideoPromptPreviewImage) => {
      openPreview(videoPromptPreviewImageToPreviewItem(image))
    },
    [openPreview],
  )

  /**
   * 提交当前选中镜头的视频生成任务。
   *
   * @returns 提交流程完成后的 Promise。
   */
  const handleSubmitVideoGeneration = useCallback(async () => {
    if (!selectedBatch || !selectedBatchKeyResolved || !onSubmitVideoGeneration) {
      return
    }

    if (submitBlocker) {
      return
    }

    const aspectRatio = videoPrompt.aspectRatio
    const seconds = selectedBatch.second

    if (!aspectRatio || !seconds) {
      return
    }

    try {
      const input = createVideoGenerationInput({
        aspectRatio,
        batch: selectedBatch,
        prompt: selectedPromptDraft.trim(),
        seconds,
      })

      setSubmittedBatchKeys(new Set())
      setSubmittingBatchKey(selectedBatchKeyResolved)
      const didSavePrompt = await savePromptCandidates([
        {
          originalPrompt: selectedBatch.prompt,
          prompt: input.prompt,
          shotIndex: selectedBatch.index,
        },
      ])

      if (!didSavePrompt) {
        return
      }

      await onSubmitVideoGeneration(input)
      setSubmittedBatchKeys(new Set([selectedBatchKeyResolved]))
    } finally {
      setSubmittingBatchKey(null)
    }
  }, [
    onSubmitVideoGeneration,
    savePromptCandidates,
    selectedBatch,
    selectedBatchKeyResolved,
    selectedPromptDraft,
    submitBlocker,
    videoPrompt.aspectRatio,
  ])

  /**
   * 提交全部视频提示词镜头的视频生成任务。
   *
   * @returns 提交流程完成后的 Promise。
   */
  const handleSubmitAllVideoGenerations = useCallback(async () => {
    if (!onSubmitVideoGenerations) {
      return
    }

    if (allGenerationSubmission.blocker) {
      return
    }

    try {
      setSubmittedBatchKeys(new Set())
      setIsSubmittingAllBatches(true)
      const didSavePrompts = await savePromptCandidates(
        allGenerationSubmission.items.map((item) => ({
          originalPrompt: item.batch.prompt,
          prompt: item.input.prompt,
          shotIndex: item.input.shotIndex,
        })),
      )

      if (!didSavePrompts) {
        return
      }

      await onSubmitVideoGenerations(allGenerationSubmission.items.map((item) => item.input))
      setSubmittedBatchKeys(new Set(allGenerationSubmission.items.map((item) => item.batchKey)))
    } finally {
      setIsSubmittingAllBatches(false)
    }
  }, [
    allGenerationSubmission.blocker,
    allGenerationSubmission.items,
    onSubmitVideoGenerations,
    savePromptCandidates,
  ])

  return (
    <article className="relative flex h-full min-h-0 flex-col overflow-hidden bg-[color:var(--color-background)] font-[var(--font-producer-ui)] text-[color:var(--color-on-background)]">
      <div
        className="nopan nowheel thin-scrollbar relative flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain"
        data-video-prompt-card-body="true"
      >
        <section className="grid min-h-0 flex-1 grid-cols-[190px_minmax(0,1fr)_330px]">
          <nav
            aria-label="视频提示词镜头"
            className="thin-scrollbar min-h-0 overflow-y-auto border-r border-[color:var(--color-border)] px-5 py-6"
          >
            <p className="mb-5 text-canvas-label leading-none font-medium text-[color:var(--color-on-surface-variant)]">
              镜头
            </p>
            <div className="grid gap-2">
              {videoPrompt.batches.map((batch) => {
                const batchKey = createVideoBatchKey(batch)
                const batchIndex = formatVideoBatchIndex(batch)
                const batchSecond = formatVideoBatchSecond(batch.second)
                const selected = batchKey === selectedBatchKeyResolved

                return (
                  <button
                    key={batchKey}
                    type="button"
                    className={cn(
                      'nodrag nopan relative w-full rounded-md px-4 py-4 text-left transition-all',
                      selected
                        ? 'bg-[color:var(--color-control-bg)] text-[color:var(--color-on-background)] shadow-[var(--shadow-rail-inset)]'
                        : 'text-[color:var(--color-on-surface-variant)] hover:bg-[color:var(--color-hover)] hover:text-[color:var(--color-on-background)]',
                    )}
                    onClick={(event) => {
                      event.stopPropagation()
                      setSelectedBatchKey(batchKey)
                      setEditingBatchKey((currentBatchKey) =>
                        currentBatchKey === batchKey ? currentBatchKey : null,
                      )
                    }}
                    onPointerDown={stopActionPropagation}
                    aria-pressed={selected}
                    aria-label={`查看视频镜头 ${batchIndex}`}
                  >
                    <span className="block text-canvas-title-sm leading-none font-semibold tracking-[0]">
                      镜头 {batchIndex}
                    </span>
                    {batchSecond ? (
                      <span className="mt-3 block text-canvas-body leading-none font-medium text-[color:var(--color-on-surface-variant)]">
                        {batchSecond}
                      </span>
                    ) : null}
                  </button>
                )
              })}
            </div>
          </nav>

          <main className="thin-scrollbar min-h-0 overflow-y-auto border-r border-[color:var(--color-border)] px-7 py-6">
            <div className="flex items-start justify-between gap-5">
              <div className="min-w-0">
                <p className="text-body leading-none font-medium tracking-[0] text-[color:var(--color-on-surface-variant)]">
                  视频提示词
                </p>
                <h3 className="mt-2 text-canvas-title-sm leading-none font-semibold tracking-[0] text-[color:var(--color-on-background)]">
                  视频镜头 {selectedBatchLabel}
                </h3>
                <p className="mt-3 text-body leading-none font-medium tracking-[0] text-[color:var(--color-on-surface-variant)]">
                  {videoPrompt.batches.length} 个镜头 · {selectedBatchSecond ?? '时长未知'} ·{' '}
                  {videoPrompt.aspectRatio ?? '比例未知'}
                </p>
              </div>

              <div className="flex shrink-0 items-center gap-2">
                {selectedBatchSecond ? (
                  <span className="inline-flex h-9 items-center rounded-lg bg-[color:var(--color-control-bg)] px-3 text-title font-medium text-[color:var(--color-on-surface-variant)]">
                    {selectedBatchSecond}
                  </span>
                ) : null}
                {selectedBatch && selectedBatchKeyResolved ? (
                  <button
                    type="button"
                    className={PROMPT_EDIT_BUTTON_CLASS}
                    data-action="edit-prompt"
                    onClick={(event) => {
                      event.stopPropagation()
                      void handlePromptEditAction()
                    }}
                    disabled={isSavingPrompt}
                    onPointerDown={stopActionPropagation}
                    title={
                      isSavingPrompt ? '保存中' : isEditingSelectedBatch ? '完成修改' : '修改提示词'
                    }
                    aria-label={
                      isSavingPrompt
                        ? `正在保存视频镜头 ${selectedBatchLabel} 提示词`
                        : isEditingSelectedBatch
                          ? `完成修改视频镜头 ${selectedBatchLabel} 提示词`
                          : `修改视频镜头 ${selectedBatchLabel} 提示词`
                    }
                    aria-pressed={isEditingSelectedBatch}
                  >
                    {isEditingSelectedBatch ? <CheckIcon /> : <PencilIcon />}
                    <span>
                      {isSavingPrompt ? '保存中' : isEditingSelectedBatch ? '完成' : '修改'}
                    </span>
                  </button>
                ) : null}
                {selectedBatch && selectedBatchKeyResolved ? (
                  <button
                    type="button"
                    className={ICON_ACTION_BUTTON_CLASS}
                    onClick={(event) => {
                      event.stopPropagation()
                      void handleCopyPrompt(selectedBatchKeyResolved, selectedPromptDraft)
                    }}
                    onPointerDown={stopActionPropagation}
                    title={copiedBatchKey === selectedBatchKeyResolved ? '复制完成' : '复制提示词'}
                    aria-label={
                      copiedBatchKey === selectedBatchKeyResolved ? '复制完成' : '复制提示词'
                    }
                  >
                    {copiedBatchKey === selectedBatchKeyResolved ? <CheckIcon /> : <CopyIcon />}
                  </button>
                ) : null}
              </div>
            </div>

            <div className="mt-5 flex flex-wrap items-center gap-2 text-body leading-none font-medium text-[color:var(--color-on-surface-variant)]">
              <span className="rounded-lg bg-[color:var(--color-control-bg)] px-3 py-2">
                最终提示词
              </span>
              <span className="rounded-lg bg-[color:var(--color-control-bg)] px-3 py-2">
                提示词就绪 · {selectedReferenceImageCount} 张参考图
              </span>
              <span className="rounded-lg bg-[color:var(--color-control-bg)] px-3 py-2">
                {getVideoGenerationStatusDisplayLabel(selectedGenerationStatus)}
              </span>
            </div>

            <div className="mt-7">
              {selectedBatch && isEditingSelectedBatch ? (
                <textarea
                  aria-label={`编辑视频镜头 ${selectedBatchLabel} 提示词`}
                  className="nodrag nopan nowheel thin-scrollbar min-h-[620px] w-full resize-none border-t border-[color:var(--color-border)] bg-transparent px-0 py-6 text-canvas-body-lg leading-[1.78] text-[color:var(--color-on-background)] placeholder:text-[color:var(--color-on-surface-variant)]"
                  onChange={(event) => {
                    if (selectedBatchKeyResolved) {
                      updatePromptDraft(selectedBatchKeyResolved, event.currentTarget.value)
                    }
                  }}
                  onPointerDown={stopActionPropagation}
                  spellCheck={false}
                  value={selectedPromptDraft}
                />
              ) : selectedBatch ? (
                <VideoPromptReadingView prompt={selectedPromptReadingText} />
              ) : (
                <p className="border-t border-[color:var(--color-border)] pt-6 text-canvas-body text-[color:var(--color-on-surface-variant)]">
                  暂无可展示的视频提示词。
                </p>
              )}
              {promptSaveErrorMessage ? (
                <p
                  className="mt-4 text-title font-medium text-[color:var(--color-danger-text)]"
                  role="alert"
                >
                  {promptSaveErrorMessage}
                </p>
              ) : null}
            </div>
          </main>

          <aside aria-label="参考图栏" className="flex min-h-0 flex-col overflow-hidden px-6 py-6">
            <p className="text-canvas-label leading-none font-medium text-[color:var(--color-on-surface-variant)]">
              参考图
            </p>
            {selectedBatch?.previewImages && selectedBatch.previewImages.length > 0 ? (
              <div
                className="nowheel thin-scrollbar mt-5 min-h-0 flex-1 [scrollbar-gutter:stable] [column-gap:16px] overflow-y-auto overscroll-contain pr-1 [column-count:2]"
                data-reference-image-masonry="true"
              >
                {selectedBatch.previewImages.map((image) => (
                  <button
                    aria-label={`双击查看 ${image.key} 图片预览`}
                    key={`${selectedBatchKeyResolved ?? selectedBatch.index}:${image.key}`}
                    className="nodrag nopan group mb-4 block w-full min-w-0 appearance-none break-inside-avoid overflow-hidden rounded-md border-0 bg-[color:var(--color-glass-surface)] p-0 text-left ring-1 ring-[color:var(--color-border)] transition-[transform,ring-color] duration-150 hover:-translate-y-0.5 hover:ring-[color:var(--color-border-hover)]"
                    data-reference-image-card="true"
                    onDoubleClick={(event) => {
                      event.stopPropagation()
                      handleReferenceImagePreviewOpen(image)
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter' && event.key !== ' ') {
                        return
                      }

                      event.preventDefault()
                      event.stopPropagation()
                      handleReferenceImagePreviewOpen(image)
                    }}
                    onPointerDown={stopActionPropagation}
                    title="双击查看大图"
                    type="button"
                  >
                    <div
                      className="relative w-full overflow-hidden"
                      data-reference-image-media="true"
                    >
                      <img
                        alt=""
                        className="block h-auto w-full object-contain transition-transform duration-200 group-hover:scale-[1.015]"
                        decoding="async"
                        draggable={false}
                        loading="lazy"
                        src={image.url}
                      />
                      <span
                        aria-hidden="true"
                        className="pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-[image:var(--media-scrim-photo)]"
                      />
                      <span
                        className="pointer-events-none absolute bottom-2 left-2 max-w-[calc(100%-16px)] truncate rounded-md bg-black/46 px-2 py-1 text-label leading-none font-medium text-white/90 backdrop-blur-sm"
                        data-reference-image-label="true"
                      >
                        {image.key}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <div
                aria-hidden="true"
                className="mt-5 min-h-0 flex-1 border-y border-dashed border-[color:var(--color-border)] bg-[color:var(--color-glass-surface)]"
              />
            )}
            <footer className="mt-4 flex shrink-0 flex-col gap-3">
              {generationFeedback ? (
                <p
                  className="text-body leading-snug font-medium text-[color:var(--color-on-surface-variant)]"
                  data-video-generation-feedback="true"
                >
                  {generationFeedback}
                </p>
              ) : null}
              <div className="flex justify-end gap-3">
                <button
                  type="button"
                  className={cn(
                    VIDEO_PROMPT_SECONDARY_BUTTON_BASE_CLASS,
                    canSubmitAllBatches
                      ? VIDEO_PROMPT_SECONDARY_BUTTON_ENABLED_CLASS
                      : VIDEO_PROMPT_DISABLED_BUTTON_CLASS,
                  )}
                  data-action="generate-all-videos"
                  disabled={!canSubmitAllBatches}
                  onClick={(event) => {
                    event.stopPropagation()
                    void handleSubmitAllVideoGenerations()
                  }}
                  onPointerDown={stopActionPropagation}
                >
                  {getVideoGenerationAllButtonLabel({
                    isSubmitted: isAllBatchesSubmitted,
                    isSubmitting: isSubmittingAllBatches,
                  })}
                </button>
                <button
                  type="button"
                  className={cn(
                    VIDEO_PROMPT_PRIMARY_BUTTON_BASE_CLASS,
                    canSubmitSelectedBatch
                      ? VIDEO_PROMPT_PRIMARY_BUTTON_ENABLED_CLASS
                      : VIDEO_PROMPT_DISABLED_BUTTON_CLASS,
                  )}
                  data-action="generate-video"
                  disabled={!canSubmitSelectedBatch}
                  onClick={(event) => {
                    event.stopPropagation()
                    void handleSubmitVideoGeneration()
                  }}
                  onPointerDown={stopActionPropagation}
                >
                  {getVideoGenerationButtonLabel({
                    generationStatus: selectedGenerationStatus,
                    isSubmitted: selectedBatchKeyResolved
                      ? submittedBatchKeys.has(selectedBatchKeyResolved)
                      : false,
                    isSubmitting: isSubmittingSelectedBatch,
                  })}
                </button>
              </div>
            </footer>
          </aside>
        </section>
      </div>

      {preview ? (
        <MediaPreviewDialog
          key={`${preview.mediaType}:${preview.attachmentId ?? preview.url}`}
          onClose={closePreview}
          preview={preview}
        />
      ) : null}
    </article>
  )
}
