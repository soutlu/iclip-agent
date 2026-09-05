/** 202 后由生成任务列表轮询进度；提交中及已有运行任务时禁用按钮，不提供幂等键（ADR-0009 决策 4）。 */

import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useState } from 'react'
import { toast } from '@/shared/ui/toast'
import type { Shot } from './shots'
import { storyboardQueryKeys, submitVideoGeneration, VIDEO_ASPECT_RATIOS } from './storyboard.api'

type UseVideoGenerationOptions = {
  conversationId: string
  aspectRatio: string
}

export const useVideoGeneration = ({ aspectRatio, conversationId }: UseVideoGenerationOptions) => {
  const queryClient = useQueryClient()
  const [submitting, setSubmitting] = useState<readonly number[]>([])
  const aspectRatioSupported = VIDEO_ASPECT_RATIOS.includes(aspectRatio)

  const submit = useCallback(
    async (shot: Shot) => {
      if (!aspectRatioSupported) return
      setSubmitting((current) => [...current, shot.index])
      try {
        await submitVideoGeneration({
          aspectRatio,
          conversationId,
          imageUrls: shot.imageUrls,
          prompt: shot.prompt,
          seconds: shot.seconds,
          shotIndex: shot.index,
        })
        await queryClient.invalidateQueries({
          queryKey: storyboardQueryKeys.generations(conversationId),
        })
      } catch (error) {
        toast.error(error instanceof Error ? error.message : '出片没发出去')
      } finally {
        setSubmitting((current) => current.filter((index) => index !== shot.index))
      }
    },
    [aspectRatio, aspectRatioSupported, conversationId, queryClient],
  )

  return { aspectRatioSupported, submit, submitting }
}
