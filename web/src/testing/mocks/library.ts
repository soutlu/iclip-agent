/** 资料库的 mock：几张画幅、作者、脚本形态各异的卡，筛选与翻页照合同 §13 在内存里做。

单测与 dev:mock 共用；测试要断言具体内容就用 `server.use` 喂自己的数据，不拿这里的演示数据当预期值。 */

import { http, HttpResponse } from 'msw'
import type { z } from 'zod'
import type { zLibraryVideoOut, zScriptOut } from '@/shared/api/generated/zod.gen'
// no-inline：地址要进 <video src>，不能被构建内联成 data URI。
import sampleWideUrl from '../fixtures/sample-video-wide.webm?no-inline'
import sampleVideoUrl from '../fixtures/sample-video.webm?no-inline'
import { mockAuthUser } from './auth-user'
import { pageBy } from './paging'

type LibraryVideo = z.output<typeof zLibraryVideoOut>
type Script = z.output<typeof zScriptOut>

const HOUR_MS = 60 * 60_000

/** 脚本里 `@Image1` 指的商品图。 */
const REFERENCE_IMAGE =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='240' height='320'%3E%3Crect width='240' height='320' fill='%23ece6dc'/%3E%3Cpath d='M40 210 Q60 150 120 160 L200 190 Q210 230 190 240 L50 240 Q36 232 40 210Z' fill='%23f7f3ea' stroke='%23a8742a' stroke-width='6'/%3E%3C/svg%3E"

type Spec = {
  title: string | null
  shot: number | null
  author: string
  aspectRatio: string
  model: string
  hoursAgo: number
  script: Script | null
  prompt: string
  takes?: number
  masterMs?: number
}

const script = (globalSettings: string, ...cuts: [number, number, string][]): Script => ({
  globalSettings,
  timeline: cuts.map(([start, end, prompt]) => ({
    end,
    imageIndexes: [...prompt.matchAll(/@Image(\d+)/g)].map((match) => Number(match[1])),
    prompt,
    start,
  })),
})

const SPECS: readonly Spec[] = [
  {
    aspectRatio: '9:16',
    author: mockAuthUser.username,
    hoursAgo: 0.2,
    model: 'mmt-seedance-2-5',
    prompt: '浅灰纯色背景棚拍……',
    script: script(
      '浅灰纯色背景棚拍，正面固定机位；男性模特灰色 T 恤，柔光均匀。',
      [0, 3.5, '开场，中景。模特双手背在身后站定。'],
      [3.5, 9, '硬切，近景。双手托出 @Image1 米白厚底跑鞋，缓慢转动。'],
      [9, 15, '硬切，同机位。换成黑色配色，结尾停在正侧面。'],
    ),
    shot: 1,
    title: '跑鞋手持展示',
  },
  {
    aspectRatio: '3:4',
    author: mockAuthUser.username,
    hoursAgo: 3,
    model: 'mmt-seedance-2-5',
    prompt: '晴天户外滑板场……',
    script: script(
      '晴天户外滑板场，涂鸦坡道与铁丝网；年轻女性栗色厚底靴。',
      [0, 0.9, '开场，全景，极低机位仰拍固定。'],
      [0.9, 1.9, '硬切，特写，俯拍。双腿悬空轻晃。'],
      [1.9, 2.9, '硬切，近景。她把滑板竖抱在身前。'],
      [2.9, 6, '硬切，贴地侧面跟拍，靴底落地声叠在鼓点上。'],
    ),
    shot: 1,
    takes: 6,
    title: '滑板女孩 · 厚底靴街拍',
  },
  {
    aspectRatio: '16:9',
    author: 'Mia.Chen',
    hoursAgo: 5,
    masterMs: 15_040,
    model: 'wan3.0-video-prime',
    prompt: '夏日海边……',
    script: script(
      '夏日海边，晴空与浅色沙滩；两个孩子穿魔术贴运动凉鞋。',
      [0, 5, '开场，远景，低机位跟拍。'],
      [5, 10, '硬切，特写。小手按下 @Image1 白色魔术贴。'],
      [10, 15, '硬切，近景仰拍，定格收尾。'],
    ),
    shot: 1,
    takes: 3,
    title: '童鞋海边亲子',
  },
  {
    aspectRatio: '9:16',
    author: 'Nina.He',
    hoursAgo: 26,
    model: 'mmt-seedance-2-0',
    prompt: '浅灰水泥地面与白墙……',
    script: script(
      '浅灰水泥地面与白墙，干净留白。',
      [0, 3, '开场，固定俯拍。空地面停一拍。'],
      [3, 10, '硬切，脚部特写。模特踩入夹趾凉鞋站定。'],
    ),
    shot: 1,
    title: '春夏凉鞋合集',
  },
  {
    aspectRatio: '9:16',
    author: 'Nina.He',
    hoursAgo: 26.5,
    model: 'mmt-seedance-2-5',
    prompt: '居家客厅……',
    script: script(
      '居家客厅，几何地毯与木柜；自然窗光。',
      [0, 4, '开场，中景。棕色厚底凉鞋入画。'],
      [4, 12, '硬切，近景。她弯腰扣好脚踝带。'],
    ),
    shot: 2,
    takes: 2,
    title: '春夏凉鞋合集',
  },
  {
    aspectRatio: '16:9',
    author: 'Shan.Hu',
    hoursAgo: 50,
    model: 'mmt-seedance-2-5',
    prompt: '一条横版的纯文本描述，没有分镜结构。',
    script: null,
    shot: null,
    title: null,
  },
  {
    aspectRatio: '4:5',
    author: 'Ken.Wu',
    hoursAgo: 120,
    masterMs: 12_000,
    model: 'wan3.0-video-prime',
    prompt: '纯色深蓝渐变背景……',
    script: script(
      '纯色深蓝渐变背景，产品 CG 质感。',
      [0, 4, '开场，超微距，鞋侧 logo 浮雕。'],
      [4, 12, '硬切，中景。鞋子悬浮翻转。'],
    ),
    shot: 1,
    title: '跑鞋质感大片',
  },
]

const idOf = (prefix: string, index: number) =>
  `${prefix}-0000-4000-8000-${String(index).padStart(12, '0')}`

const videoOf = (spec: Spec, index: number, now: number): LibraryVideo => {
  const takeId = idOf('7a1c0000', index)
  const takeAt = new Date(now - spec.hoursAgo * HOUR_MS).toISOString()
  const [w = 9, h = 16] = spec.aspectRatio.split(':').map(Number)
  const url = w > h ? sampleWideUrl : sampleVideoUrl
  const masterAt = new Date(now - spec.hoursAgo * HOUR_MS + 60_000).toISOString()
  const masters =
    spec.masterMs === undefined
      ? []
      : [
          {
            createdAt: masterAt,
            durationMs: spec.masterMs,
            id: idOf('7a1d0000', index),
            outputUrl: url,
          },
        ]
  return {
    agentId: 'storyboard',
    conversationId: spec.author === mockAuthUser.username ? idOf('7a1e0000', index) : null,
    face:
      spec.masterMs === undefined
        ? {
            createdAt: takeAt,
            durationMs: null,
            jobId: takeId,
            kind: 'take',
            outputUrl: url,
            watermarkOutputUrl: url,
          }
        : {
            createdAt: masterAt,
            durationMs: spec.masterMs,
            jobId: idOf('7a1d0000', index),
            kind: 'master',
            outputUrl: url,
            watermarkOutputUrl: null,
          },
    id: takeId,
    shotIndex: spec.shot,
    take: {
      aspectRatio: spec.aspectRatio,
      createdAt: takeAt,
      generateAudio: false,
      id: takeId,
      masters,
      model: spec.model,
      outputUrl: url,
      prompt: spec.prompt,
      referenceImageUrls: spec.script?.timeline.some((cut) => cut.imageIndexes.length > 0)
        ? [REFERENCE_IMAGE]
        : [],
      resolution: '720p',
      script: spec.script,
      seconds: spec.script?.timeline.at(-1)?.end ?? 10,
      userName: spec.author,
      watermarkOutputUrl: url,
    },
    takeCount: spec.takes ?? 1,
    taskId: null,
    title: spec.title,
  }
}

/** 演示用的全部卡片，时刻相对此刻往前排。 */
export const mockLibraryVideos = (now: number = Date.now()): LibraryVideo[] =>
  SPECS.map((spec, index) => videoOf(spec, index, now))

/** 这一镜的全部出片，早的在前：卡面那次是最后一次，之前每隔一小时出过一次。 */
const takesOf = (video: LibraryVideo, index: number): LibraryVideo['take'][] => {
  const last = video.takeCount - 1
  const at = Date.parse(video.take.createdAt)
  return Array.from({ length: video.takeCount }, (_, order) =>
    order === last
      ? video.take
      : {
          ...video.take,
          createdAt: new Date(at - (last - order) * HOUR_MS).toISOString(),
          id: idOf('7a1f0000', index * 10 + order),
          masters: [],
        },
  )
}

const orientationOf = (video: LibraryVideo): 'portrait' | 'landscape' | null => {
  const [w = 0, h = 0] = (video.take.aspectRatio ?? '').split(':').map(Number)
  return w > h ? 'landscape' : w < h ? 'portrait' : null
}

const matches = (video: LibraryVideo, query: URLSearchParams): boolean => {
  const userName = query.get('userName')
  const orientation = query.get('orientation')
  const since = query.get('since')
  const until = query.get('until')
  const q = query.get('q')?.toLowerCase()
  const at = Date.parse(video.face.createdAt)
  return (
    (userName === null || video.take.userName === userName) &&
    (orientation === null || orientationOf(video) === orientation) &&
    (since === null || at >= Date.parse(since)) &&
    (until === null || at < Date.parse(until)) &&
    (q === undefined ||
      video.take.prompt.toLowerCase().includes(q) ||
      (video.title ?? '').toLowerCase().includes(q))
  )
}

export const libraryHandlers = [
  http.get('*/api/library/videos', ({ request }) => {
    const query = new URL(request.url).searchParams
    const cursor = query.get('cursor')
    const rows = mockLibraryVideos().filter((video) => matches(video, query))
    const page = pageBy(
      rows,
      (video) => [video.face.createdAt, video.id],
      cursor,
      Number(query.get('limit') ?? 20),
    )
    return HttpResponse.json({ ...page, total: cursor === null ? rows.length : null })
  }),

  // 这一镜里任何一次出片的 id 都能打开它；同一段对话的其他镜在演示数据里就是同标题的卡。
  http.get('*/api/library/videos/:id', ({ params }) => {
    const all = mockLibraryVideos()
    const shot = all
      .map((video, index) => ({ takes: takesOf(video, index), video }))
      .find(({ takes }) => takes.some((take) => take.id === params['id']))
    if (shot === undefined)
      return HttpResponse.json({ detail: '资料库里没有这条视频' }, { status: 404 })
    const { takes, video } = shot
    const siblings = all.filter(
      (row) => row.id !== video.id && row.title !== null && row.title === video.title,
    )
    return HttpResponse.json({ siblings, takes, video })
  }),

  http.get('*/api/library/authors', () => {
    const counts = new Map<string, number>()
    for (const video of mockLibraryVideos()) {
      const name = video.take.userName
      if (name !== null) counts.set(name, (counts.get(name) ?? 0) + 1)
    }
    const items = [...counts]
      .map(([userName, count]) => ({ count, userName }))
      .sort((a, b) => b.count - a.count || a.userName.localeCompare(b.userName))
    return HttpResponse.json({ items })
  }),
]
