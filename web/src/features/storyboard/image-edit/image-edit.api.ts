import { useInfiniteQuery } from '@tanstack/react-query'
import { apiFetch } from '@/shared/api/client'
import {
  zGenerationEnvelope,
  zGenerationsPageOut,
  zImageGenerationIn,
} from '@/shared/api/generated/zod.gen'
import type { GenerationJob } from '../storyboard.api'
import { isRunningStatus } from '../shots'
import type { EditInstruction, FrameEditDraft, FrameEditTarget } from './image-edit-types'

export const imageEditQueryKey = (target: FrameEditTarget) =>
  ['frame-edits', target.conversationId, target.shotIndex, target.frameNumber] as const

export function useImageEditJobs(target: FrameEditTarget) {
  return useInfiniteQuery({
    queryKey: imageEditQueryKey(target),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams({
        conversationId: target.conversationId,
        kind: 'image',
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

/** 提交过的那一批图片，用来把历史记录装回编辑器。 */
export const readSubmittedImages = (job: GenerationJob) => {
  const urls = job.request['referenceImageUrls']
  return Array.isArray(urls) ? urls.filter((url) => typeof url === 'string') : []
}

export const readSubmittedPrompt = (job: GenerationJob) => {
  const prompt = job.request['prompt']
  return typeof prompt === 'string' ? prompt : ''
}

/** 不说这句，模型会把圈和编号一起画进结果里。 */
const ANNOTATION_NOTICE = '图中的编号和圈选只表示位置，输出干净的图片，不保留标注。'
const IMAGE_MARK = /@图片(\d+)/g

/** 芯片落成 `@图片N` / `@标注N`；编号即它在本次提交里的位置，与仓里 `@ImageN` 同一套写法。 */
export function compileEditPrompt(draft: FrameEditDraft): string {
  const indexOf = new Map(draft.references.map((reference, at) => [reference.id, at + 1]))
  const numberOf = new Map(
    draft.annotations.map((annotation) => [annotation.id, annotation.number]),
  )
  const annotated = draft.references.some((reference) => reference.kind === 'annotated')
  const body = draft.instructions
    .map((part) =>
      part.kind === 'text'
        ? part.text
        : part.kind === 'referenceImage'
          ? `@图片${indexOf.get(part.id)}`
          : `@标注${numberOf.get(part.id)}`,
    )
    .join('')
  return annotated ? `${body}\n${ANNOTATION_NOTICE}` : body
}

/** 把提交过的 prompt 拆回编辑器：`@图片N` 装回芯片，其余原样留成文字。
 *
 * `@标注N` 只能留成文字——芯片要指向画布上那个圈，而圈的形状没有随请求存下来。 */
export function parseEditPrompt(
  prompt: string,
  references: readonly { id: string }[],
): EditInstruction[] {
  const body = prompt.replace(`\n${ANNOTATION_NOTICE}`, '')
  const parts: EditInstruction[] = []
  const pushText = (text: string) => {
    if (text.length > 0) parts.push({ kind: 'text', text })
  }
  let at = 0
  for (const match of body.matchAll(IMAGE_MARK)) {
    const reference = references[Number(match[1]) - 1]
    if (reference === undefined) continue
    pushText(body.slice(at, match.index))
    parts.push({ kind: 'referenceImage', id: reference.id })
    at = match.index + match[0].length
  }
  pushText(body.slice(at))
  return parts
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
    frameNumber: target.frameNumber,
    ...options,
    prompt: compileEditPrompt(draft),
    referenceImageUrls: draft.references.map((reference) => reference.url),
  })
  const result = await apiFetch('/generations', zGenerationEnvelope, {
    method: 'POST',
    body,
    fallbackErrorMessage: '图片编辑任务提交失败',
  })
  return result.generation
}
