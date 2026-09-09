import { ApiError } from '@/shared/api/client'
import { Button } from '@/shared/ui/button'
import {
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogRoot,
  DialogSurface,
} from '@/shared/ui/dialog'
import { toast } from '@/shared/ui/toast'
import { useDeleteCollection } from '../collections.api'

type CollectionDeleteDialogProps = {
  collection?: { id: string; name: string } | undefined
  onOpenChange: (open: boolean) => void
  onDeleted: () => void
  open: boolean
}

export function CollectionDeleteDialog({
  collection,
  onOpenChange,
  onDeleted,
  open,
}: CollectionDeleteDialogProps) {
  const deleteMutation = useDeleteCollection(() => {
    toast.success('合集已删除')
    onDeleted()
    onOpenChange(false)
  })

  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogSurface aria-label="删除合集">
        <DialogHeader
          className="h-(--layout-dialog-header-height) items-center border-b-0 px-6 py-0"
          closeLabel="关闭"
          title="删除合集"
        />
        <DialogBody className="flex flex-col gap-2 px-6 pt-2.5 pb-6">
          <p className="text-body break-all text-on-surface">{collection?.name}</p>
          <p className="text-body-sm text-on-surface-variant">
            里面的对话不会被删掉，只是不再属于任何合集。
          </p>
        </DialogBody>
        <DialogFooter>
          <span />
          <div className="flex gap-2">
            <Button className="min-w-[74px]" onClick={() => onOpenChange(false)} variant="outlined">
              取消
            </Button>
            <Button
              className="min-w-[74px]"
              loading={deleteMutation.isPending}
              onClick={() => {
                if (!collection) return
                deleteMutation.mutate(collection.id, {
                  onError: (error) => {
                    toast.error(error instanceof ApiError ? error.message : '删除失败，请重试')
                  },
                })
              }}
              variant="danger"
            >
              删除
            </Button>
          </div>
        </DialogFooter>
      </DialogSurface>
    </DialogRoot>
  )
}
