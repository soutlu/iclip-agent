/**
 * 分镜工作台（只读）：一屏一个镜头组，底部胶片条翻组。
 *
 * 内容来自两处——工作区里的 `video_shot.json`（组、prompt、帧地址）与这段对话的生成任务
 * （每组当前的成片、还在飞的那几组）。文件变了由 `event.fs.changed` 通知，只重读那一份。
 */

import { useQueryClient } from '@tanstack/react-query'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { use, useEffect, useRef, useState } from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { TranscriptConnectionContext } from '@/shared/transcript/transcript-context'
import { IconButton } from '@/shared/ui/button'
import { Tag, tagVariants } from '@/shared/ui/tag'
import {
  useWorkspaceFile,
  workspaceQueryKeys,
  type ArtifactRendererProps,
} from '@/shared/workbench'
import {
  aspectRatioStyle,
  latestShotVideos,
  parseShotsDocument,
  runningShots,
  shotName,
  shotStatus,
  splitPrompt,
  SHOTS_PATH,
  type ShotStatus,
} from '../shots'
import { useShotGenerations } from '../storyboard.api'

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
  const queryClient = useQueryClient()
  const connection = use(TranscriptConnectionContext)
  const navigate = useNavigate()
  const search: { frame?: number; shot?: number } = useSearch({ strict: false })

  useEffect(() => {
    if (connection === null) return undefined
    return connection.watchFs(conversationId, [path], () => {
      void queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.file(conversationId, path),
      })
    })
  }, [connection, conversationId, path, queryClient])

  // 「agent 刚改过」：重读回来的版本号与上一次拿到的不同就标上，点开任一组即清。
  // 逐组 diff 这一期不做，所以标在整条胶片条上。
  const version = file.data?.file.version
  const seenVersionRef = useRef<number | undefined>(undefined)
  const [changedByAgent, setChangedByAgent] = useState(false)
  useEffect(() => {
    if (version === undefined) return
    if (seenVersionRef.current !== undefined && seenVersionRef.current !== version) {
      setChangedByAgent(true)
    }
    seenVersionRef.current = version
  }, [version])

  if (file.isPending) return <PanelNotice text="正在读取分镜…" />
  if (file.isError) return <PanelNotice text={file.error.message} />

  const shotsDocument = parseShotsDocument(file.data.file.content)
  const shots = shotsDocument?.shots ?? []
  const position = search.shot !== undefined && search.shot <= shots.length ? search.shot : 1
  const shot = shots[position - 1]
  if (shotsDocument === undefined || shotsDocument === null || shot === undefined) {
    return <PanelNotice text="文件格式不对，读不出镜头组" />
  }

  const frames = shot.imageUrls.map((url, offset) => ({
    id: `${offset + 1}`,
    number: offset + 1,
    url,
  }))
  const framePicked = search.frame !== undefined && search.frame <= frames.length
  const frameNumber = framePicked ? (search.frame ?? 1) : 1
  const currentFrame = frames[frameNumber - 1]

  const jobs = generations.data?.items ?? []
  const videos = latestShotVideos(jobs)
  const running = runningShots(jobs)
  const video = videos.get(shot.index)
  // 有成片就先放成片；点过缩略图之后换成那一帧——用户这时想看的是帧本身。
  const showVideo = video !== undefined && !framePicked

  const go = (next: { frame?: number | undefined; shot?: number | undefined }) => {
    setChangedByAgent(false)
    void navigate({ search: { ...search, ...next }, to: '.' })
  }

  const totalSeconds = shots.reduce((sum, item) => sum + item.seconds, 0)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <p className="shrink-0 px-6 pt-3 text-body-sm text-on-surface-faint">
        {shots.length} 组 · 合计 {totalSeconds} 秒
      </p>

      <div className="flex min-h-0 flex-1 items-center gap-2 px-3 py-2">
        <IconButton
          disabled={position === 1}
          label="上一组"
          name="back"
          onClick={() => go({ frame: undefined, shot: position - 1 })}
          size="lg"
        />

        <article className="grid min-h-0 flex-1 grid-cols-[300px_1fr] overflow-hidden rounded-lg border-[0.5px] border-chat-hairline bg-chat-card-bg">
          <div className="flex min-h-0 flex-col bg-surface-container">
            <div
              className="flex min-h-0 flex-1 items-center justify-center overflow-hidden"
              style={{ aspectRatio: aspectRatioStyle(shotsDocument.aspectRatio) }}
            >
              {showVideo ? (
                <video className="max-h-full max-w-full" controls src={video}>
                  <track kind="captions" />
                </video>
              ) : currentFrame === undefined ? (
                <p className="text-body-sm text-on-surface-faint">这一组没有帧</p>
              ) : (
                <img
                  alt={`镜头组 ${shot.index} 第 ${frameNumber} 帧`}
                  className="max-h-full max-w-full object-contain"
                  src={currentFrame.url}
                />
              )}
            </div>

            <div className="flex shrink-0 gap-1.5 overflow-x-auto border-t-[0.5px] border-chat-hairline bg-chat-card-bg p-2.5">
              {frames.map((frame) => (
                <button
                  aria-current={frame.number === frameNumber}
                  aria-label={`第 ${frame.number} 帧`}
                  className={cn(
                    'relative size-12 shrink-0 cursor-pointer overflow-hidden rounded-xs bg-surface-container-high ui-focus',
                    frame.number === frameNumber && 'outline-2 -outline-offset-2 outline-primary',
                  )}
                  key={frame.id}
                  onClick={() => go({ frame: frame.number })}
                  type="button"
                >
                  <img alt="" className="size-full object-cover" src={frame.url} />
                  <span className="absolute top-0 left-0 rounded-br-xs bg-chat-card-bg px-1 text-caption text-on-surface-variant">
                    @{frame.number}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="flex min-h-0 flex-col gap-3 p-6">
            <h3 className="flex items-center gap-2.5 text-title font-semibold text-on-surface">
              <ShotBadge index={shot.index} />
              {shotName(shot)}
            </h3>
            <p className="text-body-sm text-on-surface-faint">
              {shot.seconds} 秒 · {frames.length} 帧
            </p>
            <p className="text-label text-on-surface-faint">分镜描述</p>
            <div className="min-h-0 flex-1 overflow-y-auto rounded-md bg-surface-container-low p-4 text-body leading-loose whitespace-pre-wrap text-on-surface">
              {splitPrompt(shot.prompt).map((segment) =>
                segment.kind === 'text' ? (
                  <span key={segment.id}>{segment.text}</span>
                ) : (
                  <button
                    aria-label={`高亮第 ${segment.number} 帧`}
                    className={cn(
                      tagVariants({ variant: 'soft' }),
                      'mx-0.5 cursor-pointer align-middle ui-focus',
                      segment.number === frameNumber &&
                        'bg-primary-container text-on-primary-container',
                    )}
                    key={segment.id}
                    onClick={() => go({ frame: segment.number })}
                    type="button"
                  >
                    @{segment.number}
                  </button>
                ),
              )}
            </div>
          </div>
        </article>

        <IconButton
          disabled={position === shots.length}
          label="下一组"
          name="next"
          onClick={() => go({ frame: undefined, shot: position + 1 })}
          size="lg"
        />
      </div>

      <div
        aria-label="镜头组"
        className="flex shrink-0 gap-3 overflow-x-auto border-t-[0.5px] border-chat-hairline px-6 py-4"
      >
        {shots.map((item) => {
          const status = shotStatus(item.index, videos, running)
          return (
            <button
              aria-current={item.index === shot.index}
              className={cn(
                'flex w-45 shrink-0 cursor-pointer flex-col overflow-hidden rounded-md border-[0.5px] border-chat-hairline bg-chat-card-bg text-left ui-focus',
                item.index === shot.index && 'outline-2 -outline-offset-2 outline-primary',
              )}
              key={item.index}
              onClick={() => go({ frame: undefined, shot: item.index })}
              type="button"
            >
              <span className="relative flex h-25 items-center justify-center overflow-hidden bg-surface-container">
                {item.imageUrls[0] === undefined ? null : (
                  <img alt="" className="size-full object-cover" src={item.imageUrls[0]} />
                )}
                <span
                  className={cn(
                    tagVariants({ variant: 'soft' }),
                    'absolute top-2 left-2 bg-chat-card-bg',
                  )}
                >
                  {item.seconds}s
                </span>
                <span
                  aria-label={DOT_LABEL[status]}
                  className={cn('absolute top-3 right-3 size-2 rounded-full', DOT_CLASS[status])}
                  role="img"
                />
              </span>
              <span className="flex items-center gap-2 px-2.5 py-2 text-body-sm text-on-surface">
                <ShotBadge index={item.index} />
                <span className="min-w-0 flex-1 truncate">{shotName(item)}</span>
                {changedByAgent ? <Tag variant="running">agent 刚改过</Tag> : null}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

type ShotBadgeProps = { index: number }

/**
 * 序号方块。
 *
 * @param props - 组件属性。
 * @param props.index - 第几组。
 * @returns 序号方块。
 */
function ShotBadge({ index }: ShotBadgeProps) {
  return (
    <span className="inline-grid size-5.5 shrink-0 place-items-center rounded-xs bg-secondary-container text-label font-semibold text-on-secondary-container">
      {index}
    </span>
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
