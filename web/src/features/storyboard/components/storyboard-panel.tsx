/** shot 查询参数是当前组的事实源，滚动与导航保持同步。文件更新走 event.fs.changed，生成状态走任务轮询。 */

import { useQueryClient } from '@tanstack/react-query'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { use, useEffect, useRef, useState } from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { TranscriptConnectionContext } from '@/shared/transcript/transcript-context'
import { Button } from '@/shared/ui/button'
import {
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogRoot,
  DialogSurface,
} from '@/shared/ui/dialog'
import { Tag } from '@/shared/ui/tag'
import {
  useWorkbenchSelection,
  useWorkspaceFile,
  workspaceQueryKeys,
  type ArtifactRendererProps,
} from '@/shared/workbench'
import { latestShotVideos, runningShots, shotSelectionRef, SHOTS_PATH } from '../shots'
import { uploadFrameImage, useFrameCandidates, useShotGenerations } from '../storyboard.api'
import { useShotsDraft } from '../use-shots-draft'
import { useVideoGeneration } from '../use-video-generation'
import { AllShotsSheet } from './all-shots-sheet'
import { GenerationRecords } from './generation-records'
import { ShotPage } from './shot-page'

const pageOfScroll = (element: HTMLElement): number | undefined =>
  element.clientHeight > 0 ? Math.round(element.scrollTop / element.clientHeight) + 1 : undefined

export function StoryboardPanel({ artifact, conversationId }: ArtifactRendererProps) {
  const path = artifact.source.kind === 'file' ? artifact.source.path : SHOTS_PATH
  const file = useWorkspaceFile(conversationId, path)
  const generations = useShotGenerations(conversationId)
  const candidates = useFrameCandidates(conversationId)
  const draft = useShotsDraft({ conversationId, file: file.data?.file, path })
  const queryClient = useQueryClient()
  const connection = use(TranscriptConnectionContext)
  const navigate = useNavigate()
  const search: { frame?: number; sheet?: 'all' | 'records'; shot?: number } = useSearch({
    strict: false,
  })
  const pagesRef = useRef<HTMLDivElement | null>(null)
  // 记录滚动目标，在到达前忽略中间位置，避免误改 shot 和 frame 查询参数。
  const scrollTargetRef = useRef<number | null>(null)

  useEffect(() => {
    if (connection === null) return undefined
    return connection.watchFs(conversationId, [path], () => {
      void queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.file(conversationId, path),
      })
    })
  }, [connection, conversationId, path, queryClient])

  // 版本变化且非本地保存时显示 agent 修改提示，切组后清除。
  const version = file.data?.file.version
  const seenVersionRef = useRef<number | undefined>(undefined)
  const [changedByAgent, setChangedByAgent] = useState(false)
  const { wroteVersion } = draft
  useEffect(() => {
    if (version === undefined) return
    const seen = seenVersionRef.current
    seenVersionRef.current = version
    if (seen !== undefined && seen !== version && !wroteVersion(version)) setChangedByAgent(true)
  }, [version, wroteVersion])

  const shotsDocument = draft.document
  const shots = shotsDocument?.shots ?? []
  const position = search.shot !== undefined && search.shot <= shots.length ? search.shot : 1
  const generation = useVideoGeneration({
    aspectRatio: shotsDocument?.aspectRatio ?? '',
    conversationId,
  })

  // 当前组和帧同步为聊天引用，面板卸载时清除。
  const { clear: clearSelection, set: setSelection } = useWorkbenchSelection()
  const frameCount = shots[position - 1]?.imageUrls.length ?? 0
  const selectedFrame =
    search.frame !== undefined && search.frame >= 1 && search.frame <= frameCount
      ? search.frame
      : undefined
  useEffect(() => {
    if (shots.length === 0) return
    setSelection([shotSelectionRef(position, selectedFrame)])
  }, [position, selectedFrame, setSelection, shots.length])
  useEffect(() => () => clearSelection(), [clearSelection])

  // 查询参数驱动滚动；反向同步仅在页码变化时更新，避免循环。
  useEffect(() => {
    const element = pagesRef.current
    if (element === null) return
    const showing = pageOfScroll(element)
    if (showing === undefined || showing === position) return
    scrollTargetRef.current = position
    const top = (position - 1) * element.clientHeight
    // 使用瞬时滚动，避免平滑过程的中间页写回地址并清除 frame。
    element.scrollTo({ behavior: 'instant', top })
    // 下一帧再次校准位置，防止 scroll-snap 的后续布局将跳转拉回。
    const frame = requestAnimationFrame(() => {
      if (element.scrollTop !== top) element.scrollTo({ behavior: 'instant', top })
    })
    return () => cancelAnimationFrame(frame)
  }, [position])

  if (file.isPending) return <PanelNotice text="正在读取分镜…" />
  if (file.isError) return <PanelNotice text={file.error.message} />

  const shot = shots[position - 1]
  if (shotsDocument === null || shot === undefined) {
    return <PanelNotice text="文件格式不对，读不出镜头组" />
  }

  const frames = shot.imageUrls
  const frameNumber =
    search.frame !== undefined && search.frame >= 1 && search.frame <= frames.length
      ? search.frame
      : 1

  const jobs = generations.data?.items ?? []
  const videos = latestShotVideos(jobs)
  const running = runningShots(jobs)

  const generateNote = !generation.aspectRatioSupported
    ? `画幅 ${shotsDocument.aspectRatio} 不在出片支持的档位里，先改文件里的画幅`
    : draft.state.kind === 'saving'
      ? '描述还在保存，存好了再出片'
      : draft.state.kind === 'error'
        ? '描述没存下，先把它存下来再出片'
        : undefined
  const generatingShot = (index: number) =>
    running.has(index) || generation.submitting.includes(index)

  /** 逐组提交，跳过已有运行任务的组。 */
  const generateMany = async (indexes: readonly number[]) => {
    for (const index of indexes) {
      const target = shots.find((item) => item.index === index)
      if (target === undefined || generatingShot(index)) continue
      await generation.submit(target)
    }
  }

  const go = (next: {
    frame?: number | undefined
    sheet?: 'all' | 'records' | undefined
    shot?: number
  }) => {
    // 切组时清除帧号，避免沿用上一组的帧位置。
    const cleared = next.shot !== undefined && next.shot !== position ? { frame: undefined } : {}
    if (next.shot !== undefined && next.shot !== position) setChangedByAgent(false)
    void navigate({ replace: true, search: { ...search, ...cleared, ...next }, to: '.' })
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
    if (showing === position) return
    go({ shot: Math.min(Math.max(showing, 1), shots.length) })
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0
    if (step === 0) return
    const next = position + step
    if (next < 1 || next > shots.length) return
    event.preventDefault()
    go({ shot: next })
  }

  return (
    <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex min-w-0 shrink-0 items-center gap-2 px-4 pt-2 pb-1">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 wrap-anywhere">
          {changedByAgent ? <Tag variant="running">agent 刚改过</Tag> : null}
          <SaveStatus state={draft.state} />
        </div>
        <Button
          className="shrink-0"
          onClick={() => go({ sheet: search.sheet === 'records' ? undefined : 'records' })}
          size="md"
          variant="primary"
        >
          生成记录
        </Button>
      </div>

      <div className="relative flex min-h-0 w-full min-w-0 flex-1 overflow-hidden">
        <div
          className="flex min-h-0 min-w-0 flex-1 snap-y snap-mandatory flex-col overflow-x-hidden overflow-y-auto [overflow-anchor:none]"
          onScroll={onScroll}
          ref={pagesRef}
        >
          {shots.map((item, offset) => (
            <ShotPage
              aspectRatio={shotsDocument.aspectRatio}
              candidates={candidates.data ?? []}
              frameNumber={offset + 1 === position ? frameNumber : 1}
              generateDisabled={generateNote !== undefined || generatingShot(item.index)}
              generateNote={generateNote}
              generating={generatingShot(item.index)}
              key={`${item.index}-${offset + 1 === position ? 'active' : 'inactive'}`}
              onChangeShot={draft.updateShot}
              onGenerateVideo={() => void generation.submit(item)}
              onOpenAllShots={() => go({ sheet: 'all', shot: offset + 1 })}
              onPickFrame={(frame) => go({ frame, shot: offset + 1 })}
              onUploadFrame={uploadFrameImage}
              shot={item}
            />
          ))}
        </div>

        {/* 原生页码按钮同时提供键盘翻页入口。 */}
        <nav
          aria-label="镜头组页码"
          className="flex shrink-0 flex-col items-center justify-center gap-2 px-2"
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
              onKeyDown={onKeyDown}
              type="button"
            />
          ))}
        </nav>

        {search.sheet === 'all' ? (
          <aside
            aria-label="全部分镜"
            className="absolute inset-0 flex min-w-0 animate-in flex-col bg-background shadow-[var(--shadow-2)] duration-(--dur-m) ease-(--ease-decel) slide-in-from-right"
          >
            <AllShotsSheet
              aspectRatio={shotsDocument.aspectRatio}
              onClose={() => go({ sheet: undefined })}
              onGenerate={(indexes) => void generateMany(indexes)}
              onOpenShot={(index) => go({ sheet: undefined, shot: index })}
              onTalk={(indexes) => {
                setSelection(
                  indexes.map((index) => shotSelectionRef(index)),
                  { focus: true },
                )
                go({ sheet: undefined })
              }}
              running={running}
              shots={shots}
              videos={videos}
            />
          </aside>
        ) : null}

        {search.sheet === 'records' ? (
          <aside
            aria-label="生成记录"
            className="absolute inset-y-0 right-0 flex w-full max-w-100 min-w-0 animate-in flex-col border-l-[0.5px] border-chat-hairline bg-background shadow-[var(--shadow-2)] duration-(--dur-m) ease-(--ease-decel) slide-in-from-right"
          >
            <GenerationRecords
              jobs={jobs}
              onClose={() => go({ sheet: undefined })}
              shotIndex={shot.index}
            />
          </aside>
        ) : null}
      </div>

      <ConflictDialog resolve={draft.resolveConflict} state={draft.state} />
    </div>
  )
}

type SaveStatusProps = { state: ReturnType<typeof useShotsDraft>['state'] }

function SaveStatus({ state }: SaveStatusProps) {
  switch (state.kind) {
    case 'saving':
      return <span className="text-body-sm text-on-surface-faint">保存中…</span>
    case 'saved':
      return (
        <span className="flex items-center gap-1 text-body-sm text-on-surface-faint">
          <Icon decorative name="check" size="xs" />
          已保存
        </span>
      )
    case 'error':
      return (
        <span className="text-body-sm text-error" role="alert">
          没存下：{state.message}
        </span>
      )
    case 'idle':
    case 'conflict':
      return null
  }
}

type ConflictDialogProps = {
  state: ReturnType<typeof useShotsDraft>['state']
  resolve: (choice: 'mine' | 'theirs') => void
}

/** 同组并发修改必须由用户选择保留本地或服务端版本。 */
function ConflictDialog({ resolve, state }: ConflictDialogProps) {
  const open = state.kind === 'conflict'
  const indexes = state.kind === 'conflict' ? state.shots.map((item) => item.index) : []
  return (
    <DialogRoot onOpenChange={(next) => !next && resolve('theirs')} open={open}>
      <DialogSurface aria-label="这一组有别的改动">
        <DialogHeader closeLabel="关闭（用最新的）" title="这一组有别的改动">
          你改的时候，第 {indexes.join('、')} 组也被别人改过了。
        </DialogHeader>
        <DialogBody>
          <p className="text-body text-on-surface">
            留我的会把你这几组的改动覆盖到最新版上；用最新的会丢掉你对这几组的改动，其余组不受影响。
          </p>
        </DialogBody>
        <DialogFooter>
          <span />
          <span className="flex gap-2">
            <Button onClick={() => resolve('theirs')} size="md" variant="ghost">
              用最新的
            </Button>
            <Button onClick={() => resolve('mine')} size="md">
              留我的
            </Button>
          </span>
        </DialogFooter>
      </DialogSurface>
    </DialogRoot>
  )
}

type PanelNoticeProps = { text: string }

function PanelNotice({ text }: PanelNoticeProps) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center gap-2 px-6 text-center">
      <Icon className="text-on-surface-faint" decorative name="file" size="sm" />
      <p className="text-body-sm text-on-surface-variant">{text}</p>
    </div>
  )
}
