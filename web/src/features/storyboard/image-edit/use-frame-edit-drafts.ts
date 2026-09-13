/** 一格上各张底图的编辑草稿：读、改、暂存到 sessionStorage。 */

import { useEffect, useRef, useState } from 'react'
import { toast } from '@/shared/ui/toast'
import {
  editDraftKey,
  isEmptyDraft,
  loadEditDrafts,
  type FrameEditDrafts,
} from './image-edit-draft'
import type { FrameEditDraft, FrameEditTarget } from './image-edit-types'

export type FrameEditDraftStore = {
  /** 各张底图的草稿；取某一张用 `draftOf`，调用方自己记忆化。 */
  drafts: FrameEditDrafts
  updateDraft: (baseUrl: string, draft: FrameEditDraft) => void
  /** 这张底图的输入作废：应用之后画在它上面的圈没有意义了。 */
  clearDraft: (baseUrl: string) => void
  /** 本地草稿读坏了；给出提示，用户可以选择重新开始。 */
  error: string | null
  reset: () => void
}

export function useFrameEditDrafts(target: FrameEditTarget): FrameEditDraftStore {
  const [initial] = useState<{ drafts: FrameEditDrafts; error: string | null }>(() => {
    try {
      return { drafts: loadEditDrafts(target), error: null }
    } catch {
      return { drafts: {}, error: '本地编辑草稿读取失败，请重新开始或从历史任务恢复输入' }
    }
  })
  const [drafts, setDrafts] = useState(initial.drafts)
  const [error, setError] = useState(initial.error)
  const storageFailedRef = useRef(false)

  useEffect(() => {
    if (error !== null) return
    try {
      sessionStorage.setItem(editDraftKey(target), JSON.stringify(drafts))
    } catch {
      if (!storageFailedRef.current) toast.error('编辑草稿无法暂存，关闭页面前请先提交生成')
      storageFailedRef.current = true
    }
  }, [drafts, error, target])

  return {
    drafts,
    updateDraft: (baseUrl, draft) =>
      setDrafts((current) => {
        if (isEmptyDraft(draft)) {
          const { [baseUrl]: _dropped, ...rest } = current
          return rest
        }
        return { ...current, [baseUrl]: draft }
      }),
    clearDraft: (baseUrl) =>
      setDrafts((current) => {
        const { [baseUrl]: _dropped, ...rest } = current
        return rest
      }),
    error,
    reset: () => {
      setDrafts({})
      setError(null)
    },
  }
}
