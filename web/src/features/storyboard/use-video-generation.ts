/** 只在提交请求期间防止重复点击；202 后由任务列表轮询进度，同组可继续生成新版本。 */

import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useRef, useState } from 'react'
import { toast } from '@/shared/ui/toast'
import type { Shot } from './shots'
import { storyboardQueryKeys, submitVideoGeneration, VIDEO_ASPECT_RATIOS } from './storyboard.api'
import { DEFAULT_VIDEO_OPTIONS } from './video-generation-options'

type UseVideoGenerationOptions = {
  conversationId: string
  aspectRatio: string
}

export const useVideoGeneration = ({ aspectRatio, conversationId }: UseVideoGenerationOptions) => {
  const queryClient = useQueryClient()
  const [submitting, setSubmitting] = useState<readonly number[]>([])
  const submittingRef = useRef(new Set<number>())
  const [options, setOptions] = useState(DEFAULT_VIDEO_OPTIONS)
  const aspectRatioSupported = VIDEO_ASPECT_RATIOS.includes(aspectRatio)

  const submit = useCallback(
    async (shot: Shot) => {
      if (!aspectRatioSupported || submittingRef.current.has(shot.index)) return
      // 同一次渲染内的重复触发也只发一次请求，不等待按钮状态重绘。
      submittingRef.current.add(shot.index)
      setSubmitting((current) => [...current, shot.index])
      try {
        await submitVideoGeneration({
          ...options,
          aspectRatio,
          conversationId,
          imageUrls: shot.imageUrls,
          prompt: shot.prompt,
          seconds: shot.seconds,
          shotIndex: shot.index,
        })
        void queryClient.invalidateQueries({
          queryKey: storyboardQueryKeys.generations(conversationId),
        })
      } catch (error) {
        toast.error(error instanceof Error ? error.message : '出片没发出去')
      } finally {
        submittingRef.current.delete(shot.index)
        setSubmitting((current) => current.filter((index) => index !== shot.index))
      }
    },
    [aspectRatio, aspectRatioSupported, conversationId, options, queryClient],
  )

  return { aspectRatioSupported, options, setOptions, submit, submitting }
}
