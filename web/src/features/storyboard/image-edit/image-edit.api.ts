import { useInfiniteQuery } from '@tanstack/react-query'
import { apiFetch } from '@/shared/api/client'
import {
  zFrameEditContext,
  zGenerationEnvelope,
  zGenerationsPageOut,
  zImageGenerationIn,
} from '@/shared/api/generated/zod.gen'
import type { GenerationJob } from '../storyboard.api'
import { isRunningStatus } from '../shots'
import type { FrameEditDraft, FrameEditTarget } from './image-edit-types'

export const imageEditQueryKey = (target: FrameEditTarget) =>
  [
    'frame-edits',
    target.conversationId,
    target.artifactPath,
    target.shotIndex,
    target.frameNumber,
  ] as const

export function useImageEditJobs(target: FrameEditTarget) {
  return useInfiniteQuery({
    queryKey: imageEditQueryKey(target),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams({
        conversationId: target.conversationId,
        kind: 'image',
        artifactPath: target.artifactPath,
        shotIndex: String(target.shotIndex),
        frameNumber: String(target.frameNumber),
        limit: '20',
      })
      if (pageParam !== undefined) params.set('before', pageParam)
      return apiFetch(`/generations?${params}`, zGenerationsPageOut, {
        signal,
        fallbackErrorMessage: '读取图片编辑记录失败',
      })
    },
    getNextPageParam: (page) => (page.items.length >= 20 ? page.items.at(-1)?.id : undefined),
    refetchInterval: ({ state }) =>
      state.data?.pages.some((page) => page.items.some((job) => isRunningStatus(job.status)))
        ? 5000
        : false,
  })
}

export const readFrameEdit = (job: GenerationJob) => {
  const parsed = zFrameEditContext.safeParse(job.request['frameEdit'])
  return parsed.success ? parsed.data : null
}

export async function submitImageEdit(
  target: FrameEditTarget,
  draft: FrameEditDraft,
  options: { channel: 'dev' | 'pro'; resolution: '1k' | '2k' | '4k'; aspectRatio: string },
) {
  const body = zImageGenerationIn.parse({
    kind: 'image',
    conversationId: target.conversationId,
    shotIndex: target.shotIndex,
    ...options,
    // 服务端从 frameEdit.instructions 编译并冻结最终指令。
    prompt: '图片编辑',
    referenceImageUrls: draft.references.map((reference) => reference.url),
    frameEdit: {
      artifactPath: target.artifactPath,
      frameNumber: target.frameNumber,
      sourceUrl: target.sourceUrl,
      ...draft,
    },
  })
  const result = await apiFetch('/generations', zGenerationEnvelope, {
    method: 'POST',
    body,
    fallbackErrorMessage: '图片编辑任务提交失败',
  })
  return result.generation
}
