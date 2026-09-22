import { useState } from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { Button, IconButton } from '@/shared/ui/button'
import { formatShotPrompts, shotName, type Shot } from '../shot-document'
import { aspectRatioStyle } from '../shots'
import { copyWithToast } from './copy-with-toast'

type ShotOverviewProps = {
  shots: readonly Shot[]
  aspect_ratio: string
  onClose: () => void
  onOpenShot: (index: number) => void
}

/** 「全部镜头组」抽屉：每组一张卡，可多选后一次复制提示词。 */
export function ShotOverview({ shots, aspect_ratio, onClose, onOpenShot }: ShotOverviewProps) {
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
            void copyWithToast(formatShotPrompts(chosen), `已复制 ${chosen.length} 个镜头组`)
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
