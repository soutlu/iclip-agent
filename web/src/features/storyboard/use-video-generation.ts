/** 出片的模型选项、提交与失败原因。防重复点击归调用方的出片闸门（useGenerationGate）；202 后由
 * 任务列表轮询进度，同组可继续生成新版本。
 *
 * 出片失败的原因留在这里按镜头组记着，由工作台渲染在出片按钮旁边：全局 toast 弹在视口
 * 底部、压着聊天输入区，离按下的按钮太远。 */

import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { errorMessageOf } from '@/shared/api/client'
import type { Shot } from './shot-document'
import { storyboardQueryKeys, submitVideoGeneration, useVideoModels } from './storyboard.api'
import { DEFAULT_GENERATE_AUDIO, type VideoGenerationOptions } from './video-generation-options'

export const useVideoGeneration = (conversationId: string) => {
  const queryClient = useQueryClient()
  const models = useVideoModels()
  // 只留最近一次失败：提示挨着出片按钮，同时只看得见当前这一组。
  const [failure, setFailure] = useState<{ index: number; message: string } | undefined>(undefined)
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
    if (model === undefined) return
    setFailure(undefined)
    try {
      await submitVideoGeneration({
        aspectRatio,
        conversationId,
        generateAudio: options.generateAudio,
        model,
        shot,
      })
      void queryClient.invalidateQueries({
        queryKey: storyboardQueryKeys.videoJobs(conversationId),
      })
    } catch (error) {
      setFailure({ index: shot.index, message: errorMessageOf(error, '视频提交失败') })
    }
  }

  return {
    /** 这一组上次出片失败的原因；换组就不显示，不用清。 */
    errorOf: (index: number) => (failure?.index === index ? failure.message : undefined),
    models: items,
    modelsUnavailable: models.isError,
    options,
    /** 出片路上、提交之前就失败的（例如取不到已保存的镜头组），走同一条提示通道。 */
    reportError: (index: number, message: string) => setFailure({ index, message }),
    setOptions: setWanted,
    submit,
  }
}
