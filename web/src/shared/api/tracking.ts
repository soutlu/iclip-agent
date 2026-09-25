/** 埋点事件：用户做了要记账的事就报一条，服务端只追加落表。发起人与发生时刻由服务端定，这里只报事件名与主语。 */

import type { z } from 'zod'
import { apiFetch } from '@/shared/api/client'
import {
  zRecordEventTrackingEventsPostResponse,
  type zRecordEventTrackingEventsPostBody,
} from '@/shared/api/generated/zod.gen'

type TrackingEvent = z.input<typeof zRecordEventTrackingEventsPostBody>

/**
 * 记一次视频下载，主语 jobId 是被下载那个地址所属的生成记录；原片与水印版同属一条记录。
 *
 * 默认不打扰用户：调用方不等它回来，与取字节并行；失败不抛、不弹 toast，只 console.warn 一条——
 * 丢一条记账不该挡住用户拿片子。keepalive 让请求在页面随即跳走或关闭时仍能发完。
 */
export const recordVideoDownloaded = (jobId: string): void => {
  const event: TrackingEvent = { jobId, name: 'video.downloaded' }
  apiFetch('/tracking/events', zRecordEventTrackingEventsPostResponse, {
    body: event,
    fallbackErrorMessage: '记录下载失败',
    keepalive: true,
    method: 'POST',
  }).catch((error: unknown) => {
    console.warn('下载埋点没记上', { error, jobId })
  })
}
