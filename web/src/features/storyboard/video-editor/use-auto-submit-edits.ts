import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import type { VideoEditMetadata } from '../generation-metadata'
import { actualEditStart, type PendingEdit } from './edit-chain'
import type { EditorReference } from './editor-composer'
import { submitVideoEdit, videoEditConversationKey } from './video-editor.api'

/** 本次会话发起的一次编辑要交给模型的东西；参考片段切好那一刻用它发编辑任务。 */
export type EditDraft = { prompt: string; model: string; references: EditorReference[] }

type Origin = {
  conversationId: string
  taskId: string | null
  rootJobId: string
}

/** 参考片段切好就自动发编辑任务：按后端报的实际时长反算起点，把片段交给模型。
 *
 * 一个 editId 只自动发一次，提交失败也不再自动重发（那会变成一渲染一次的重试风暴），用户重选
 * 一段就是重来。切好却没带时长的片段发不了，留给渲染按记录直接说出来。 */
export const useAutoSubmitEdits = ({
  pending,
  drafts,
  origin,
  onError,
}: {
  pending: readonly PendingEdit[]
  drafts: Readonly<Record<string, EditDraft>>
  origin: Origin
  onError: (message: string) => void
}): void => {
  const queryClient = useQueryClient()
  const submittedRef = useRef(new Set<string>())
  const { conversationId, taskId, rootJobId } = origin

  useEffect(() => {
    for (const edit of pending) {
      const clipUrl = edit.reference?.outputUrl
      const clipMs = edit.reference?.durationMs
      const draft = drafts[edit.key]
      if (edit.stage !== 'cut' || clipUrl == null || draft === undefined) continue
      if (submittedRef.current.has(edit.key)) continue
      if (clipMs == null) continue
      submittedRef.current.add(edit.key)
      const metadata: VideoEditMetadata = {
        ...edit.coords,
        editStart: actualEditStart(edit.coords.editEnd, clipMs / 1000),
      }
      submitVideoEdit({
        conversationId,
        taskId,
        rootJobId,
        metadata,
        model: draft.model,
        prompt: draft.prompt,
        referenceVideoUrl: clipUrl,
        referenceImageUrls: draft.references.map((reference) => reference.url),
      })
        .then(() =>
          queryClient.invalidateQueries({ queryKey: videoEditConversationKey(conversationId) }),
        )
        .catch((error: unknown) => {
          onError(error instanceof Error ? error.message : '视频编辑提交失败')
        })
    }
  }, [pending, drafts, conversationId, taskId, rootJobId, onError, queryClient])
}
