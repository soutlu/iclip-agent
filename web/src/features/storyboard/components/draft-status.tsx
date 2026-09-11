/** 镜头组草稿的保存状态、冲突弹窗与读取提示；两个阅读器共用一份，文案不各自分叉。 */

import { Button } from '@/shared/ui/button'
import {
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogRoot,
  DialogSurface,
} from '@/shared/ui/dialog'
import type { SaveState } from '../use-shots-draft'

export function ReaderNotice({ text }: { text: string }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center gap-2 px-6 text-center">
      <p className="text-body-sm text-on-surface-variant">{text}</p>
    </div>
  )
}

type SaveStatusProps = {
  state: SaveState
  hasUnsavedChanges: boolean
  /** 上传已落地但分镜还没保存时，提示要说清图片没丢。 */
  appliedUpload?: boolean | undefined
  onRetry: () => void
}

export function SaveStatus({
  state,
  hasUnsavedChanges,
  appliedUpload = false,
  onRetry,
}: SaveStatusProps) {
  if (state.kind === 'error')
    return (
      <>
        <span className="text-body-sm text-error" role="alert">
          <span>{appliedUpload && hasUnsavedChanges ? '已上传，分镜未保存' : '没存下'}</span>：
          {state.message}
        </span>
        <Button onClick={onRetry} size="md" variant="ghost">
          重试保存
        </Button>
      </>
    )
  if (state.kind === 'conflict')
    return <span className="text-body-sm text-on-surface-faint">有版本冲突待处理</span>
  if (state.kind === 'saving')
    return <span className="text-body-sm text-on-surface-faint">保存中…</span>
  if (hasUnsavedChanges) return <span className="text-body-sm text-on-surface-faint">待保存</span>
  if (state.kind === 'saved')
    return <span className="text-body-sm text-on-surface-faint">已保存</span>
  return null
}

export function ConflictDialog({
  state,
  resolve,
}: {
  state: SaveState
  resolve: (choice: 'mine' | 'theirs') => void
}) {
  const conflicts = state.kind === 'conflict' ? state.shots : []
  const removed = conflicts.some((conflict) => conflict.theirs === undefined)
  return (
    <DialogRoot
      onOpenChange={(open) => !open && resolve('theirs')}
      open={state.kind === 'conflict'}
    >
      <DialogSurface aria-label="这一组有别的改动">
        <DialogHeader closeLabel="关闭（用最新的）" title="这一组有别的改动">
          第 {conflicts.map((conflict) => conflict.index).join('、')} 组在你编辑时被更新了。
        </DialogHeader>
        <DialogBody>
          <p className="text-body text-on-surface">
            {removed
              ? '原镜头组已被移除，当前修改不能覆盖到其它镜头组。采用最新版本只会放弃冲突组的修改。'
              : '选择保留你的修改，或采用这些镜头组的最新版本；其它组的草稿会保留。'}
          </p>
        </DialogBody>
        <DialogFooter>
          <span />
          <span className="flex gap-2">
            <Button onClick={() => resolve('theirs')} size="md" variant="ghost">
              用最新的
            </Button>
            <Button disabled={removed} onClick={() => resolve('mine')} size="md">
              留我的
            </Button>
          </span>
        </DialogFooter>
      </DialogSurface>
    </DialogRoot>
  )
}
