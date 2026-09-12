/** 只在提交请求期间防止重复点击；202 后由任务列表轮询进度，同组可继续生成新版本。 */

import { useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { toast } from '@/shared/ui/toast'
import type { Shot } from './shot-document'
import { storyboardQueryKeys, submitVideoGeneration, useVideoModels } from './storyboard.api'
import { DEFAULT_GENERATE_AUDIO, type VideoGenerationOptions } from './video-generation-options'

export const useVideoGeneration = (conversationId: string, path: string) => {
  const queryClient = useQueryClient()
  const models = useVideoModels()
  const [submitting, setSubmitting] = useState<readonly number[]>([])
  const submittingRef = useRef(new Set<number>())
  const [wanted, setWanted] = useState<VideoGenerationOptions>({
    generateAudio: DEFAULT_GENERATE_AUDIO,
    model: undefined,
  })
  // 选过的模型不在允许表里（配置改了）就退回默认，不用副作用改 state。
  const items = models.data?.items ?? []
  const model =
    wanted.model !== undefined && items.includes(wanted.model) ? wanted.model : models.data?.default
  const options: VideoGenerationOptions = { generateAudio: wanted.generateAudio, model }

  const submit = async (shot: Shot, aspectRatio: string) => {
    if (model === undefined || submittingRef.current.has(shot.index)) return
    // 同一次渲染内的重复触发也只发一次请求，不等待按钮状态重绘。
    submittingRef.current.add(shot.index)
    setSubmitting((current) => [...current, shot.index])
    try {
      await submitVideoGeneration({
        aspectRatio,
        conversationId,
        generateAudio: options.generateAudio,
        model,
        path,
        shot,
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
  }

  return {
    models: items,
    modelsUnavailable: models.isError,
    options,
    setOptions: setWanted,
    submit,
    submitting,
  }
}
