import type { ReactNode } from 'react'
import { Button } from '@/shared/ui/button'
import {
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogRoot,
  DialogSurface,
} from '@/shared/ui/dialog'

/**
 * 素材选择弹层的通用多选切换：按 key 比对，已选则移除，未选则追加到末尾。
 *
 * @param items - 当前已选集合。
 * @param item - 被点击的候选项。
 * @param keyOf - 取身份键。
 * @returns 切换后的新集合。
 */
export const togglePicked = <TItem,>(
  items: TItem[],
  item: TItem,
  keyOf: (item: TItem) => string,
): TItem[] =>
  items.some((current) => keyOf(current) === keyOf(item))
    ? items.filter((current) => keyOf(current) !== keyOf(item))
    : [...items, item]

type TaskPickerDialogProps = {
  /** body 容器的附加 className（各弹层自己的内容排版）。 */
  bodyClassName?: string
  children: ReactNode
  /** 已选内容的名词，如「图片」「视频」。 */
  countNoun: string
  /** 已选数量的量词，如「张」「条」。 */
  countUnit: string
  description: string
  onClose: () => void
  selectedCount: number
  title: string
}

/**
 * 两个素材选择弹层（ERP图片 / 爆款视频）共用的骨架：遮罩 + 居中弹层 +
 * 「标题 / 描述 / 已选计数 / 关闭」的 header + 「已选统计 / 完成」的 footer，
 * body 由调用方填充。
 *
 * @param props - 标题文案、已选计数与 body 内容。
 * @returns 打开状态的素材选择弹层。
 */
export default function TaskPickerDialog({
  bodyClassName,
  children,
  countNoun,
  countUnit,
  description,
  onClose,
  selectedCount,
  title,
}: TaskPickerDialogProps) {
  return (
    <DialogRoot
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          onClose()
        }
      }}
    >
      <DialogSurface aria-label={title}>
        <DialogHeader
          actions={
            <span>
              {selectedCount} {countUnit}已选
            </span>
          }
          closeLabel={`关闭${title}`}
          title={title}
        >
          <DialogDescription className="mt-1 text-body-sm text-on-surface-variant">
            {description}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className={bodyClassName}>{children}</DialogBody>

        <DialogFooter>
          <span>
            已选择 {selectedCount} {countUnit}
            {countNoun}
          </span>
          <Button onClick={onClose}>完成</Button>
        </DialogFooter>
      </DialogSurface>
    </DialogRoot>
  )
}
