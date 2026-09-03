/**
 * 分镜工作台：一屏一个镜头组，上下翻页换组，改了就存。
 *
 * 翻组是一个纵向 scroll-snap 容器：滚轮 / 触控板上下滑、↑↓ 键、右侧页码点，三条路都只改地址里的
 * `shot`，再由一个效果滚到那一页——这样「地址即当前页」，刷新与分享链接都落在同一组上。
 *
 * 内容来自两处——工作区里的 `video_shot.json`（组、prompt、帧地址）与这段对话的生成任务
 * （每组的出片记录）。文件变了由 `event.fs.changed` 通知，只重读那一份。用户的改动经
 * `useShotsDraft` 落草稿、停手即存、撞版本再比对（见那里）。
 */

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
  useWorkspaceFile,
  workspaceQueryKeys,
  type ArtifactRendererProps,
} from '@/shared/workbench'
import { latestShotVideos, runningShots, shotStatus, SHOTS_PATH, type ShotStatus } from '../shots'
import { uploadFrameImage, useFrameCandidates, useShotGenerations } from '../storyboard.api'
import { useShotsDraft } from '../use-shots-draft'
import { GenerationRecords } from './generation-records'
import { ShotPage } from './shot-page'

const DOT_CLASS: Record<ShotStatus, string> = {
  idle: 'bg-outline-variant',
  ready: 'bg-chat-status-success',
  running: 'bg-chat-status-running',
}

const DOT_LABEL: Record<ShotStatus, string> = {
  idle: '还没出片',
  ready: '已出片',
  running: '正在出片',
}

/** 容器高度取不到（jsdom、还没布局）时按「已经在正确的页上」处理，不去滚。 */
const pageOfScroll = (element: HTMLElement): number | undefined =>
  element.clientHeight > 0 ? Math.round(element.scrollTop / element.clientHeight) + 1 : undefined

/**
 * 渲染分镜工作台。
 *
 * @param props - 渲染器属性。
 * @param props.artifact - 选中的产物。
 * @param props.conversationId - 哪一段对话。
 * @returns 分镜工作台。
 */
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
  // 正在往哪一页跳。跳的过程中（浏览器的吸附动画也算）会一路发 scroll，中途那些位置属于
  // 「路过」，认真读的话会被当成翻到别的组、把地址连同 frame 一起改掉。
  const scrollTargetRef = useRef<number | null>(null)

  useEffect(() => {
    if (connection === null) return undefined
    return connection.watchFs(conversationId, [path], () => {
      void queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.file(conversationId, path),
      })
    })
  }, [connection, conversationId, path, queryClient])

  // 「agent 刚改过」：重读回来的版本号变了、又不是自己写出去的，就标上，翻页即清。
  // 逐组 diff 这一期不做，所以标在页头那一行上。
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

  // 地址变了滚到那一页。反向（滚动改地址）在 onScroll 里，两边各自比对当前页，不会来回打架。
  useEffect(() => {
    const element = pagesRef.current
    if (element === null) return
    const showing = pageOfScroll(element)
    if (showing === undefined || showing === position) return
    scrollTargetRef.current = position
    const top = (position - 1) * element.clientHeight
    // 瞬时跳而不是 smooth：平滑动画途中每一帧都在发 scroll，那些中途位置会被 onScroll 当成
    // 「翻到别的组了」写回地址，把 frame 一起清掉。
    element.scrollTo({ behavior: 'instant', top })
    // 跳完还要在下一帧确认一次：这一跳会在同一帧里被吸附容器随后那次布局拉回原处（实测如此），
    // 补这一下之后落点才留得住。
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
  const status = shotStatus(shot.index, latestShotVideos(jobs), runningShots(jobs))

  const go = (next: {
    frame?: number | undefined
    sheet?: 'records' | undefined
    shot?: number
  }) => {
    // 换组就把帧号丢掉：第 1 组的第 5 帧放到第 2 组上没有意义。
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
      // 还在往目标页去的路上：到了才把这道闸放开，没到就当这一帧没发生过。
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

  const totalSeconds = shots.reduce((sum, item) => sum + item.seconds, 0)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 px-4 pt-2 pb-1">
        <p className="text-body-sm text-on-surface-faint">
          {shots.length} 组 · 合计 {totalSeconds} 秒 · 第 {position} 组
        </p>
        {changedByAgent ? <Tag variant="running">agent 刚改过</Tag> : null}
        <SaveStatus state={draft.state} />
        <span className="flex-1" />
        {/* 圆点单独一颗没人看得懂，配上一句状态文字 */}
        <span className="flex items-center gap-1.5 text-body-sm text-on-surface-faint">
          <span aria-hidden className={cn('size-2 shrink-0 rounded-full', DOT_CLASS[status])} />
          {DOT_LABEL[status]}
        </span>
        <Button
          leadingIcon="history"
          onClick={() => go({ sheet: search.sheet === 'records' ? undefined : 'records' })}
          size="md"
          variant="ghost"
        >
          生成记录
        </Button>
      </div>

      <div className="relative flex min-h-0 flex-1">
        <div
          className="flex min-h-0 flex-1 snap-y snap-mandatory flex-col overflow-y-auto [overflow-anchor:none]"
          onScroll={onScroll}
          ref={pagesRef}
        >
          {shots.map((item, offset) => (
            <ShotPage
              aspectRatio={shotsDocument.aspectRatio}
              candidates={candidates.data ?? []}
              frameNumber={offset + 1 === position ? frameNumber : 1}
              key={item.index}
              onChangeShot={draft.updateShot}
              onPickFrame={(frame) => go({ frame })}
              onUploadFrame={uploadFrameImage}
              shot={item}
            />
          ))}
        </div>

        {/* 页码点也是键盘翻页的落点：滚动容器本身挂不了 ↑↓（div 加 tabIndex 过不了 a11y 门禁） */}
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

        {search.sheet === 'records' ? (
          <aside
            aria-label="生成记录"
            className="absolute inset-y-0 right-0 flex w-2/5 min-w-0 animate-in flex-col border-l-[0.5px] border-chat-hairline bg-background shadow-[var(--shadow-2)] duration-(--dur-m) ease-(--ease-decel) slide-in-from-right"
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

/**
 * 保存状态那一小段字：存着、存好了、存不下去。冲突另有对话框。
 *
 * @param props - 组件属性。
 * @param props.state - 保存状态。
 * @returns 一段小字，没什么可说时是 null。
 */
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

/**
 * 两边改了同一组时让用户选：留我的，还是用最新的。不静默覆盖任何一方。
 *
 * @param props - 组件属性。
 * @param props.state - 保存状态。
 * @param props.resolve - 用户的选择。
 * @returns 对话框。
 */
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

/**
 * 面板里的一句话状态。
 *
 * @param props - 组件属性。
 * @param props.text - 要说的那句话。
 * @returns 居中的一句话。
 */
function PanelNotice({ text }: PanelNoticeProps) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center gap-2 px-6 text-center">
      <Icon className="text-on-surface-faint" decorative name="file" size="sm" />
      <p className="text-body-sm text-on-surface-variant">{text}</p>
    </div>
  )
}
