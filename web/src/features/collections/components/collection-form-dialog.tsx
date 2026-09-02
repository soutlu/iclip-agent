import { useState } from 'react'
import { ApiError } from '@/shared/api/client'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import {
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogRoot,
  DialogSurface,
} from '@/shared/ui/dialog'
import { Input } from '@/shared/ui/field'
import { toast } from '@/shared/ui/toast'
import { useSaveCollection } from '../collections.api'

const MAX_NAME_CHARS = 200

type CollectionFormDialogProps = {
  /** 给了就是改名（连带带出原名），没给就是新建 */
  collection?: { id: string; name: string } | undefined
  onOpenChange: (open: boolean) => void
  /** 落库之后调用，由调用方刷掉侧栏那份拓扑 */
  onSaved: () => void
  open: boolean
}

/**
 * 合集的新建 / 改名弹窗：一个名字输入框加字数计数。
 *
 * 两件事共用一个弹窗，是因为它们的表单完全一样——差别只在标题文案与要不要带原名。
 *
 * @param props - 要改名的合集（不给即新建）、开关与保存后的回调。
 * @returns 合集表单弹窗。
 */
export function CollectionFormDialog({
  collection,
  onOpenChange,
  onSaved,
  open,
}: CollectionFormDialogProps) {
  const title = collection ? '重命名合集' : '新建合集'
  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogSurface aria-label={title}>
        <DialogHeader
          className="h-(--layout-dialog-header-height) items-center border-b-0 px-6 py-0"
          closeLabel="关闭"
          title={title}
        />
        {open ? (
          <CollectionForm
            key={collection?.id ?? 'create'}
            collection={collection}
            onOpenChange={onOpenChange}
            onSaved={onSaved}
          />
        ) : null}
      </DialogSurface>
    </DialogRoot>
  )
}

function CollectionForm({
  collection,
  onOpenChange,
  onSaved,
}: Omit<CollectionFormDialogProps, 'open'>) {
  const [name, setName] = useState(collection?.name ?? '')
  const saveMutation = useSaveCollection(() => {
    toast.success(collection ? '已重命名' : '合集已新建')
    onSaved()
    onOpenChange(false)
  })

  const trimmed = name.trim()
  const unchanged = trimmed === (collection?.name ?? '')
  const submit = () => {
    if (!trimmed || unchanged) return
    saveMutation.mutate(
      { collectionId: collection?.id, name: trimmed },
      {
        onError: (error) => {
          toast.error(error instanceof ApiError ? error.message : '保存失败，请重试')
        },
      },
    )
  }

  return (
    <>
      <DialogBody className="flex flex-col gap-3 px-6 pt-2.5 pb-6">
        {collection && (
          <p className="text-body-sm text-on-surface-variant">
            原名称：<span className="font-medium break-all text-on-surface">{collection.name}</span>
          </p>
        )}
        <div className="flex flex-col gap-1">
          <Input
            aria-label="合集名称"
            className="h-(--control-height-sm) rounded-sm border-border"
            maxLength={MAX_NAME_CHARS}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit()
            }}
            placeholder="给这个合集起个名字"
            value={name}
          />
          <span
            className={cn(
              'self-end text-caption',
              name.length >= MAX_NAME_CHARS ? 'text-error' : 'text-on-surface-variant',
            )}
          >
            {name.length}/{MAX_NAME_CHARS}
          </span>
        </div>
      </DialogBody>
      <DialogFooter>
        <span />
        <div className="flex gap-2">
          <Button className="min-w-[74px]" onClick={() => onOpenChange(false)} variant="outlined">
            取消
          </Button>
          <Button
            className="min-w-[74px]"
            disabled={!trimmed || unchanged}
            loading={saveMutation.isPending}
            onClick={submit}
          >
            保存
          </Button>
        </div>
      </DialogFooter>
    </>
  )
}
