/**
 * 发出片：一组一次，也可以按选中的几组连着发。
 *
 * 提交是「发出去就算」——202 之后由生成任务表接手，界面靠重拉任务列表看进展（`useShotGenerations`
 * 在有任务在飞时自己轮询）。同一组不去防重发到毫秒级：请求在飞、以及该组名下已经有在飞的任务，
 * 界面都把按钮禁掉（ADR-0009 决策 4，不设幂等键）。
 */

import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useState } from 'react'
import { toast } from '@/shared/ui/toast'
import type { Shot } from './shots'
import { storyboardQueryKeys, submitVideoGeneration, VIDEO_ASPECT_RATIOS } from './storyboard.api'

type UseVideoGenerationOptions = {
  conversationId: string
  /** 整份文件的画幅，出片按它。 */
  aspectRatio: string
}

/**
 * 管出片的提交。
 *
 * @param options - 哪段对话、什么画幅。
 * @returns 画幅认不认、正在提交哪几组、发一组的方法。
 */
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
