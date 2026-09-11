/** 出片闸门：有组在上传或已在准备时不再发起，组件卸载后不再改状态。 */
import { useCallback, useEffect, useRef, useState } from 'react'

export const useGenerationGate = () => {
  const [preparing, setPreparing] = useState(false)
  const lifetimeRef = useRef({ busy: false, mounted: true })
  useEffect(() => {
    const current = lifetimeRef.current
    current.mounted = true
    return () => {
      current.mounted = false
    }
  }, [])
  const [uploadingGroups, setUploadingGroups] = useState<ReadonlySet<number>>(() => new Set())
  const onUploadingChange = useCallback((group: number, uploading: boolean) => {
    setUploadingGroups((current) => {
      if (current.has(group) === uploading) return current
      const next = new Set(current)
      if (uploading) next.add(group)
      else next.delete(group)
      return next
    })
  }, [])
  const uploading = uploadingGroups.size > 0
  const run = useCallback(
    async (task: (mounted: () => boolean) => Promise<void>) => {
      if (lifetimeRef.current.busy || uploading) return
      lifetimeRef.current.busy = true
      setPreparing(true)
      try {
        await task(() => lifetimeRef.current.mounted)
      } finally {
        lifetimeRef.current.busy = false
        if (lifetimeRef.current.mounted) setPreparing(false)
      }
    },
    [uploading],
  )
  return { onUploadingChange, preparing, run, uploading }
}
