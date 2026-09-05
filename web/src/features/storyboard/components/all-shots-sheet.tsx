/** 批量生成先确认数量并跳过运行中的组；点击正文切组，多选由独立勾选按钮处理。 */

import { useState } from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { Button, IconButton } from '@/shared/ui/button'
import {
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogRoot,
  DialogSurface,
} from '@/shared/ui/dialog'
import { Tag } from '@/shared/ui/tag'
import { toast } from '@/shared/ui/toast'
import { aspectRatioStyle, shotName, shotStatus, type Shot, type ShotStatus } from '../shots'

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

type AllShotsSheetProps = {
  shots: readonly Shot[]
  aspectRatio: string
  /** 当前成片地址同时驱动下载入口和状态标记。 */
  videos: ReadonlyMap<number, string>
  running: ReadonlySet<number>
  onClose: () => void
  onOpenShot: (index: number) => void
  onTalk: (indexes: readonly number[]) => void
  onGenerate: (indexes: readonly number[]) => void
}

export function AllShotsSheet({
  aspectRatio,
  onClose,
  onGenerate,
  onOpenShot,
  onTalk,
  running,
  shots,
  videos,
}: AllShotsSheetProps) {
  const [selected, setSelected] = useState<readonly number[]>([])
  const [confirming, setConfirming] = useState(false)
  const chosen = shots.filter((shot) => selected.includes(shot.index))
  const allSelected = chosen.length === shots.length && shots.length > 0

  const toggle = (index: number) => {
    setSelected((current) =>
      current.includes(index) ? current.filter((item) => item !== index) : [...current, index],
    )
  }

  const copyPrompts = async () => {
    try {
      await navigator.clipboard.writeText(chosen.map((shot) => shot.prompt).join('\n\n'))
      toast(`已复制 ${chosen.length} 组的分镜描述`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '复制失败')
    }
  }

  const download = () => {
    const ready = chosen.filter((shot) => videos.has(shot.index))
    for (const shot of ready) {
      // 跨源地址不支持 download 属性，改为在新页打开成片。
      window.open(videos.get(shot.index), '_blank', 'noopener')
    }
    const missing = chosen.length - ready.length
    if (missing > 0) toast(`${missing} 组还没有成片，跳过了`)
  }

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b-[0.5px] border-chat-hairline px-4 py-3">
          <h3 className="text-body font-medium text-on-surface">全部分镜</h3>
          <Button
            onClick={() => setSelected(allSelected ? [] : shots.map((shot) => shot.index))}
            size="md"
            variant="ghost"
          >
            {allSelected ? '取消全选' : '全选'}
          </Button>
          <span className="text-body-sm text-on-surface-faint">已选 {chosen.length} 个</span>
          <span className="flex-1" />
          <Button
            disabled={chosen.length === 0}
            leadingIcon="copy"
            onClick={() => void copyPrompts()}
            size="md"
            variant="ghost"
          >
            复制 prompt
          </Button>
          <Button
            disabled={chosen.length === 0}
            leadingIcon="external"
            onClick={download}
            size="md"
            variant="ghost"
          >
            下载成片
          </Button>
          <IconButton label="关闭全部分镜" name="close" onClick={onClose} size="sm" />
        </div>

        <ul className="grid min-h-0 flex-1 grid-cols-[repeat(auto-fill,minmax(150px,1fr))] content-start gap-3 overflow-y-auto p-4">
          {shots.map((shot) => {
            const status = shotStatus(shot.index, videos, running)
            const picked = selected.includes(shot.index)
            const first = shot.imageUrls[0]
            return (
              <li className="relative" key={shot.index}>
                <button
                  className={cn(
                    'block w-full cursor-pointer overflow-hidden rounded-md border-[0.5px] border-chat-hairline bg-chat-card-bg text-left ui-focus ui-motion-s',
                    picked && 'outline-2 -outline-offset-2 outline-primary',
                  )}
                  onClick={() => onOpenShot(shot.index)}
                  type="button"
                >
                  <span
                    className="flex items-center justify-center bg-surface-container"
                    style={{ aspectRatio: aspectRatioStyle(aspectRatio) }}
                  >
                    {first === undefined ? (
                      <span className="text-caption text-on-surface-faint">无帧</span>
                    ) : (
                      <img alt="" className="size-full object-cover" src={first} />
                    )}
                  </span>
                  <span className="flex min-w-0 flex-col gap-0.5 px-2 py-1.5">
                    <span className="text-label text-on-surface-faint">第 {shot.index} 组</span>
                    <span className="truncate text-body-sm text-on-surface">{shotName(shot)}</span>
                  </span>
                </button>

                <Tag className="absolute top-1.5 left-1.5 bg-chat-card-bg">{shot.seconds} 秒</Tag>

                <span className="absolute top-1.5 right-1.5 flex items-center gap-1.5">
                  <span
                    aria-label={DOT_LABEL[status]}
                    className={cn('size-2 shrink-0 rounded-full', DOT_CLASS[status])}
                    role="img"
                  />
                  <button
                    aria-label={`选中镜头组 ${shot.index}`}
                    aria-pressed={picked}
                    className={cn(
                      'grid size-5 cursor-pointer place-items-center rounded-full border-[0.5px] border-chat-hairline ui-focus ui-motion-s',
                      picked ? 'bg-primary text-on-primary' : 'bg-chat-card-bg text-transparent',
                    )}
                    onClick={() => toggle(shot.index)}
                    type="button"
                  >
                    <Icon decorative name="check" size="xs" />
                  </button>
                </span>
              </li>
            )
          })}
        </ul>

        <div className="flex shrink-0 items-center gap-2 border-t-[0.5px] border-chat-hairline px-4 py-3">
          <Button
            disabled={chosen.length === 0}
            leadingIcon="send"
            onClick={() => onTalk(chosen.map((shot) => shot.index))}
            size="md"
            variant="ghost"
          >
            在聊天里说
          </Button>
          <span className="flex-1" />
          <Button disabled={chosen.length === 0} onClick={() => setConfirming(true)} size="md">
            生成选中的 {chosen.length} 组
          </Button>
        </div>
      </div>

      <DialogRoot onOpenChange={setConfirming} open={confirming}>
        <DialogSurface aria-label="确认批量出片">
          <DialogHeader closeLabel="不发了" title="确认批量出片">
            要给选中的 {chosen.length} 组各发一次出片。
          </DialogHeader>
          <DialogBody>
            <p className="text-body text-on-surface">
              每一组都是一次真实的出片调用。已经在出片的组会跳过，不重复发。
            </p>
          </DialogBody>
          <DialogFooter>
            <span />
            <span className="flex gap-2">
              <Button onClick={() => setConfirming(false)} size="md" variant="ghost">
                不发了
              </Button>
              <Button
                onClick={() => {
                  setConfirming(false)
                  onGenerate(chosen.map((shot) => shot.index))
                }}
                size="md"
              >
                发出去
              </Button>
            </span>
          </DialogFooter>
        </DialogSurface>
      </DialogRoot>
    </>
  )
}
