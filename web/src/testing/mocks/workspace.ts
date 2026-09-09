/** REST 读取与 WebSocket 模拟写入共用内存文件表，确保通知后重读得到新内容。 */

import { http, HttpResponse } from 'msw'
import type {
  ImageGenerationIn,
  VideoGenerationIn,
  VideoShotIn,
} from '@/shared/api/generated/types.gen'

/** 本地 data URL 帧，避免网络依赖。 */
const FRAME_A =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='320'%3E%3Crect width='180' height='320' fill='%23e4ded2'/%3E%3Ccircle cx='90' cy='120' r='38' fill='%23a8742a'/%3E%3Crect x='60' y='170' width='60' height='110' fill='%236b5330'/%3E%3C/svg%3E"
const FRAME_B =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='320'%3E%3Crect width='180' height='320' fill='%23d3dee4'/%3E%3Cpolygon points='90,70 150,250 30,250' fill='%232a5f8a'/%3E%3C/svg%3E"

const FRAME_C =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='320'%3E%3Crect width='180' height='320' fill='%23e8d9d1'/%3E%3Crect x='40' y='90' width='100' height='140' rx='12' fill='%238a4a2a'/%3E%3C/svg%3E"

type MockFrames = { a: string; b: string; c: string }
const DATA_FRAMES: MockFrames = { a: FRAME_A, b: FRAME_B, c: FRAME_C }
const workspaceFrames = new Map<string, MockFrames>()

/** 浏览器专用 PNG，保持原示例图形，360×640 满足既有上传尺寸合同。 */
const FRAME_PNGS: Record<string, string> = {
  a: 'iVBORw0KGgoAAAANSUhEUgAAAWgAAAKAAgMAAADMdAo0AAAACVBMVEXk3tKodCprUzAOLc9JAAACEElEQVR42u3bUU6DQBSG0c4DS3A/XcI8wH5cj6vUxEQbW6Bh5teOPd8CTsgFaoTL6SRJkiRJkiRJkiRJkiRJkiRJkiRJkiSdTstH5wT8snyWk/vb05e8zH3lslxUu5/B786ZcfQeybKkDnv6Sc+xg+532NM1PccOutdhl1t07XyLXxabR5+JlNt0jc2jy0RW5A4TKWt0Tdwvve6atVF3GPaq3Dzssk7X1Kjbh70+6uZhb8iNwy5bdE2NunXYW6NuHPam3DbsHF226Zo6i23ncfssNp3HIL0jN5zHskfXR6SnPXp+RHrvAmm4RIL0rnz86svRZZ+uj0dP+/T8ePT+tXf46huTvkM+emEPSZd76PpE9HQPPaN70Pfc5wfvdDS6/Tf14K8qGo1Go8eg/W1E/xntv4Lfo/2363mIJ2bP8OBzzIfMYz7QH/TlyZgvqsZ8KRh8Szroa+Pge/Tg2/8x1yGS+yHBrZbgLk5wgyi59xTc1grumAU345L7fMEtxODuZHDjM7mnGtyuDe4EJzeZg/vXwa3x5K57cEM/+V1B8GuI5DccwS9Pkt/LBL/ySX6blPyiKvkdmCRJ0nVvm72i0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0+n/SkiRJkiRJkiRJkkbvHb9ilkSQA7ohAAAAAElFTkSuQmCC',
  b: 'iVBORw0KGgoAAAANSUhEUgAAAWgAAAKAAQMAAACL1HDkAAAABlBMVEXT3uQqX4pbgSiKAAAChElEQVR42u3TzY3eIBRG4UEsyI4GItFJKG1SGqVQAksWCOJxHMc/wOfR6HIZ6T3rZ3ve3hBCCCGEEEIIIYQQQgghhNChH4T65zT61zT6fRpdfk+iRXGTaFn8JFqVMInWJU6iTUmTaFvyJPq9lEl0KZ+ZnlCLRbsptFy0n0KrRYcptF50nEKbRacptF10nkIvy39iekr9gZ9PT6jFqt0EWq7aT6DVqsMEWq86TqDNqtME2q46T6DX5R9PT6n/4qfTE2qxaceu5aY9u1abDuxabzqya7PpxK7tpjO73pZ/OD2l/oefTU+oxa4ds5a79sxa7Towa73ryKzNrhOztrvOzHpf/tH0lPo/fjI9oRYH7Vi1PGjPqtVBB1atDzqyanPQiVXbg86s+rD8g+kp9RG/np5Qi5N2jFqetGfU6qQDo9YnHRm1OenEqO1JZ0Z9Wv7l9JT6jF9NT6jFRTs2LS/as2l10YFN64uObNpcdGLT9qIzm74s/2J6Sn3F/ekJtbhpx6TlTXsmrW46MGl905FJm5tOTNredGbSt+W701PqO+5NT6hFRTsWLSvas2hV0YFF64qOLNpUdGLRtqIzi64s35meUtdwe3pCLaraMWhZ1Z5Bq6oODFpXdWTQpqoTg7ZVnRl0dfnm9JS6jlvTE2rR0G64lg3th2vV0GG41g0dh2vT0Gm4tg2dh+vG8o3pKXUL16cn1KKp3WAtm9oP1qqpw2CtmzoO1qap02BtmzoP1s3lq9NT6jauTU+oRUe7oVp2tB+qVUeHoVp3dByqTUenodp2dB6qO8tXpqfUPXyfnlCLrnYDtexqP1Crrg4Dte7q+CWNEEIIIYQQQgghhBBCCCH0/fsDW28/8IKYIwAAAAAASUVORK5CYII=',
  c: 'iVBORw0KGgoAAAANSUhEUgAAAWgAAAKAAQMAAACL1HDkAAAABlBMVEXo2dGKSip48hP7AAAA20lEQVR42u3bsQ3CMBCG0SAKyoyQUTJaGI1RGIEyBcIMgE/ilxIJovfqr4jtlHfDAAAAAAAAAADwhbF9Wsu69VyL+Nyt78GH1J8ydetnUS/duiWHrI55KupbcCXVpVyK+rFBPRb1Glx3deFZPRf1a4O6ePji6X+nruL+T6hWq9VqtVqtVqvVarVarVar1Wq1Wq1Wq9VqtVqtVqvVarVarVYfqV7af04Bz22/yeip7TfRnc2W7znlns3bZ7P82Z5AuIMwRfsN2e5EtpeR7XyE+yQAAAAAAAAAwMG9AcTXj6eYvhqHAAAAAElFTkSuQmCC',
}
const httpFrames = (): MockFrames => {
  const url = (name: string) => new URL(`/mock-frames/${name}.png`, window.location.origin).href
  return { a: url('a'), b: url('b'), c: url('c') }
}

/** 仅含 ftyp 盒的 MP4 占位地址，避免视频元素请求外网。 */
const VIDEO_URL = 'data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDE='

const PREAMBLE = ['参考锁定：模特的服装与发型跟住 @Image1。', '剪辑形式：硬切。'].join('\n')

/** 与服务端 shot_prompt.py 同一条拼装规则：受理时把结构化 shot 拼成正文，记录里两者都存。 */
const assembleShotPrompt = (shot: VideoShotIn): string => {
  const lines = shot.timeline.map(
    (item, position) =>
      `[${item.timestamps[0]}–${item.timestamps[1]}秒｜镜头${position + 1}] ${item.prompt}`,
  )
  return `${shot.global_settings}\n\n${lines.join('\n')}\n不要生成字幕，不要生成背景音乐。`
}

/** 第 2 组那条成片当初提交的镜头组，形状与分镜文件里的 prompt 相同；带 shot 的记录才能回填。 */
const HISTORY_SHOT: VideoShotIn = {
  global_settings: PREAMBLE,
  timeline: [
    { image_indexes: [1], prompt: '第一版：她从长椅间走向镜头 @Image1。', timestamps: [0, 4] },
    { image_indexes: [2], prompt: '第一版：走到近处停下微笑 @Image2。', timestamps: [4, 11] },
  ],
}

/** 比 video_shot.json 早一点，列表里的时间才有先后。 */
const EARLIER = '2026-09-01T09:20:00Z'

const STORYBOARD_MD = [
  '## 角色设定',
  '',
  '- [人物「模特」：二十五岁上下，浅金色直发到肩，深蓝色圆领卫衣配高腰阔腿牛仔裤]',
  '- [场景「门厅」：暖木色墙面，长椅靠窗，午后侧光]',
  '',
  '## 剪辑形式',
  '',
  '以硬切为主，第 2 镜叠化转场，其余镜头保持正常播放速度。',
  '',
  '## 逐镜拉片表',
  '',
  '| 结构层级 | 出场 | Storyline |',
  '| :--- | :--- | :--- |',
  '| Open Hook | 模特、门厅 | 提着帆布包走出门厅，抬头看向前方 |',
  '| Detail Show | 模特 | 走到近处停下微笑，低头看一眼包 |',
  '| Closure | 帆布包 | 低角度拍鞋面与魔术贴细节 |',
].join('\n')

const VIDEO_DOC_MD = [
  '## 1、商业目的',
  '- **内容类型**：城市夜景延时素材——全程以固定机位与慢速摇移呈现车流与灯光',
  '- **目标人群**：需要片头与转场素材的短视频创作者',
  '',
  '## 2、结构与信息递进',
  '| 结构节点 | 时间段 | 叙事节奏 | 支撑证据 |',
  '| :--- | :--- | :--- | :--- |',
  '| Open Hook | 00:00-00:02 | 明快开篇 | 高架桥车流拉成光带 |',
  '| Detail Show | 00:02-00:08 | 律动轻快 | 楼群灯光逐层亮起 |',
].join('\n')

export const SHOTS_MOCK_PATH = 'video_shot.json'

const shotsDocument = (frames: MockFrames, updated = false) => ({
  aspect_ratio: '9:16',
  shots: [
    {
      index: 1,
      seconds: 6,
      image_urls: [frames.a],
      prompt: {
        global_settings: PREAMBLE,
        timeline: [
          {
            timestamps: [0, 6],
            prompt: '开场，模特提着帆布包走出门厅 @Image1，抬头看向前方。',
            image_indexes: [1],
          },
        ],
      },
    },
    {
      index: 2,
      seconds: 11,
      image_urls: [frames.a, frames.b, frames.a],
      prompt: {
        global_settings: PREAMBLE,
        timeline: [
          {
            timestamps: [0, 4],
            prompt: '她从长椅间走向镜头 @Image1，脚步放慢。',
            image_indexes: [1],
          },
          {
            timestamps: [4, 11],
            prompt: updated
              ? '走到近处停下微笑 @Image2，再低头看一眼包 @Image3，台词并成一句。'
              : '走到近处停下微笑 @Image2，再低头看一眼包 @Image3。',
            image_indexes: [2, 3],
          },
        ],
      },
    },
    {
      index: 3,
      seconds: 4,
      image_urls: [frames.b],
      prompt: {
        global_settings: PREAMBLE,
        timeline: [
          {
            timestamps: [0, 4],
            prompt: '低角度拍鞋面 @Image1，鞋头包覆与魔术贴细节。',
            image_indexes: [1],
          },
        ],
      },
    },
  ],
})

const noImageShotsDocument = {
  aspect_ratio: '9:16',
  shots: [
    {
      index: 1,
      seconds: 8,
      image_urls: [],
      prompt: {
        global_settings: '人物和产品外观保持一致。正常播放速度。',
        timeline: [
          {
            timestamps: [0, 3.2],
            prompt: '开场，中景，模特双手托起帆布包，展示正面。',
            image_indexes: [],
          },
          {
            timestamps: [3.2, 8],
            prompt: '硬切，特写，模特转动帆布包，展示侧面与提手。',
            image_indexes: [],
          },
        ],
      },
    },
  ],
}

type MockFile = { content: string; updatedAt: string; version: number }

type MockJob = {
  createdAt: string
  errorMessage?: string
  id: string
  kind?: 'video' | 'image'
  outputUrl?: string
  prompt: string
  request?: Record<string, unknown>
  shotIndex?: number
  status: 'completed' | 'failed' | 'submitted'
  watermarkOutputUrl?: string
}

const job = (spec: MockJob) => ({
  createdAt: spec.createdAt,
  errorMessage: spec.errorMessage ?? null,
  id: spec.id,
  kind: spec.kind ?? 'video',
  outputUrl: spec.outputUrl ?? null,
  request: spec.request ?? { prompt: spec.prompt },
  shotIndex: spec.shotIndex ?? null,
  status: spec.status,
  taskId: null,
  watermarkOutputUrl: spec.watermarkOutputUrl ?? null,
})

const workspaces = new Map<string, Map<string, MockFile>>()

const generations = new Map<string, ReturnType<typeof job>[]>()

const VIDEO_DONE_MS = 3000

/** 重置 mock 时清除完成计时器，防止写入下一个用例。 */
const timers = new Set<ReturnType<typeof setTimeout>>()

export const seedMockWorkspace = (
  conversationId: string,
  options: { httpFrames?: boolean; withoutImages?: boolean } = {},
) => {
  const frames = options.httpFrames ? httpFrames() : DATA_FRAMES
  const now = new Date().toISOString()
  if (options.withoutImages) {
    workspaceFrames.delete(conversationId)
    workspaces.set(
      conversationId,
      new Map([
        [
          SHOTS_MOCK_PATH,
          { content: JSON.stringify(noImageShotsDocument, null, 2), updatedAt: now, version: 1 },
        ],
      ]),
    )
    generations.set(conversationId, [])
    return
  }
  workspaceFrames.set(conversationId, frames)
  workspaces.set(
    conversationId,
    new Map([
      [
        SHOTS_MOCK_PATH,
        {
          content: JSON.stringify(shotsDocument(frames), null, 2),
          updatedAt: now,
          version: 1,
        },
      ],
      [
        'frames/grids/8e5263a4-3e52-4063-b0cd-5b6c7d8e9fa0.json',
        {
          content: JSON.stringify(
            {
              frames: [
                { no: 'S1-1', shot: 1, url: frames.a },
                { no: 'S2-1', shot: 2, url: frames.b },
                { no: 'S3-1', shot: 3, url: frames.c },
              ],
              gridRecordVersion: 1,
              jobId: '8e5263a4-3e52-4063-b0cd-5b6c7d8e9fa0',
            },
            null,
            2,
          ),
          updatedAt: now,
          version: 1,
        },
      ],
      // 下面几份照真实工作区的五种文件各给一份，文件页按类别渲染时有东西可看。
      ['storyboard.md', { content: STORYBOARD_MD, updatedAt: EARLIER, version: 2 }],
      [
        'video/night-city-timelapse-9a3f2c1d.md',
        { content: VIDEO_DOC_MD, updatedAt: EARLIER, version: 1 },
      ],
      [
        'frames/extraction.json',
        {
          content: JSON.stringify(
            {
              boards: [
                {
                  board: 1,
                  cells: [
                    { id: 'S1-1', shot: 1, timecode: '00:00.000', url: frames.a },
                    { id: 'S2-1', shot: 2, timecode: '00:04.000', url: frames.b },
                  ],
                  layout: '2x1',
                  shots: [1, 2],
                  url: frames.c,
                },
              ],
              extractionKey: '6339e1aeb441bdbdf7867d8f69bdcaf84b5648b5',
              extractionVersion: 1,
              intervalMs: 1000,
              video: { contentHash: 'sha256:2f71…', url: VIDEO_URL },
            },
            null,
            2,
          ),
          updatedAt: EARLIER,
          version: 1,
        },
      ],
      [
        'anchors/b18d7e94-b199-441a-b14d-86df2cca7945.json',
        {
          content: JSON.stringify(
            {
              anchorRecordVersion: 1,
              cells: [
                { description: '空景全景平视，长椅与门厅。', index: 1, url: frames.a },
                { description: '模特正面半身，浅色帆布包。', index: 2, url: frames.b },
              ],
              gridUrl: frames.c,
              jobId: 'b18d7e94-b199-441a-b14d-86df2cca7945',
              sheetAspect: '1:1',
            },
            null,
            2,
          ),
          updatedAt: EARLIER,
          version: 1,
        },
      ],
    ]),
  )
  generations.set(conversationId, [
    job({
      createdAt: '2026-09-01T10:04:00Z',
      id: '4a1e2f60-9a1e-4c2f-9c8b-1d2e3f4a5b6c',
      outputUrl: VIDEO_URL,
      prompt: '模特走向镜头，停下微笑，暖光。',
      shotIndex: 3,
      status: 'completed',
      watermarkOutputUrl: VIDEO_URL,
    }),
    job({
      createdAt: '2026-09-01T11:10:00Z',
      id: '5b2f3071-0b2f-4d30-8d9c-2e3f4a5b6c7d',
      outputUrl: VIDEO_URL,
      // 带结构化 shot 的记录可以回填镜头组；纯描述的那两条只能看不能回填。
      prompt: assembleShotPrompt(HISTORY_SHOT),
      request: { prompt: assembleShotPrompt(HISTORY_SHOT), shot: HISTORY_SHOT },
      shotIndex: 2,
      status: 'completed',
      watermarkOutputUrl: VIDEO_URL,
    }),
    job({
      createdAt: '2026-09-01T11:40:00Z',
      errorMessage: '上游返回了空结果，换个描述再试一次。',
      id: '6c304182-1c30-4e41-9eab-3f4a5b6c7d8e',
      prompt: '第 2 组第二版：加一个低头看包的动作。',
      shotIndex: 2,
      status: 'failed',
    }),
    job({
      createdAt: '2026-09-01T12:20:00Z',
      id: '7d415293-2d41-4f52-afbc-4a5b6c7d8e9f',
      prompt: '第 2 组第三版：脚步放慢，收尾停在微笑上。',
      shotIndex: 2,
      status: 'submitted',
    }),
    job({
      createdAt: '2026-09-01T09:30:00Z',
      id: '8e5263a4-3e52-4063-b0cd-5b6c7d8e9fa0',
      kind: 'image',
      outputUrl: frames.a,
      prompt: '出镜头帧：门厅全景，模特提包。',
      status: 'completed',
    }),
    job({
      createdAt: '2026-09-01T09:35:00Z',
      id: '9f6374b5-4f63-4174-91de-6c7d8e9fa0b1',
      kind: 'image',
      outputUrl: frames.b,
      prompt: '出镜头帧：近景微笑。',
      status: 'completed',
    }),
  ])
}

/** 修改第 2 组描述并递增版本；不存在工作区时返回 false。 */
export const touchMockShots = (conversationId: string): boolean => {
  const files = workspaces.get(conversationId)
  const file = files?.get(SHOTS_MOCK_PATH)
  const frames = workspaceFrames.get(conversationId)
  if (files === undefined || file === undefined || frames === undefined) return false
  files.set(SHOTS_MOCK_PATH, {
    content: JSON.stringify(shotsDocument(frames, true), null, 2),
    updatedAt: new Date().toISOString(),
    version: file.version + 1,
  })
  return true
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const imageIndexes = (prompt: string): number[] => [
  ...new Set([...prompt.matchAll(/@Image(\d+)/g)].map((match) => Number(match[1]))),
]

const hasOnlyKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).every((key) => keys.includes(key))

/** 模拟文档结构、时间顺序和图片引用校验，不模拟素材来源台账。 */
const validateShotsContent = (content: string): string | undefined => {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return '不是合法的 JSON'
  }
  if (!isRecord(parsed) || !hasOnlyKeys(parsed, ['aspect_ratio', 'shots'])) {
    return '分镜文档只能包含 aspect_ratio 和 shots'
  }
  const aspect = parsed['aspect_ratio']
  if (
    typeof aspect !== 'string' ||
    !/^\s*\+?\d+\s*:\s*\+?\d+\s*$/.test(aspect) ||
    aspect.split(':').some((part) => Number(part) <= 0)
  ) {
    return 'aspect_ratio 要写成 9:16 这样的正整数画幅'
  }
  const shots = parsed['shots']
  if (!Array.isArray(shots) || shots.length === 0) return 'shots 至少需要一个镜头组'
  for (const [offset, shot] of (shots as unknown[]).entries()) {
    if (!isRecord(shot) || !hasOnlyKeys(shot, ['index', 'seconds', 'image_urls', 'prompt'])) {
      return `镜头组 ${offset + 1} 的字段不正确`
    }
    if (shot['index'] !== offset + 1) return `index 要从 1 连续编号，第 ${offset + 1} 条不是`
    const seconds = shot['seconds']
    if (typeof seconds !== 'number' || !Number.isInteger(seconds) || seconds < 4 || seconds > 30) {
      return `镜头组 ${offset + 1} 的 seconds 要是 4-30 的整数`
    }
    const urls = shot['image_urls']
    if (
      !Array.isArray(urls) ||
      urls.some((url: unknown) => typeof url !== 'string' || url.trim().length === 0)
    ) {
      return `镜头组 ${offset + 1} 的 image_urls 必须是图片地址数组`
    }
    const prompt = shot['prompt']
    if (!isRecord(prompt) || !hasOnlyKeys(prompt, ['global_settings', 'timeline'])) {
      return `镜头组 ${offset + 1} 的 prompt 必须包含 global_settings 和 timeline`
    }
    const globalSettings = prompt['global_settings']
    if (typeof globalSettings !== 'string' || globalSettings.trim().length === 0) {
      return `镜头组 ${offset + 1} 的 global_settings 不能为空`
    }
    const timeline = prompt['timeline']
    if (!Array.isArray(timeline) || timeline.length === 0) {
      return `镜头组 ${offset + 1} 的 timeline 至少需要一个镜头`
    }
    if (imageIndexes(globalSettings).some((index) => index < 1 || index > urls.length)) {
      return `镜头组 ${offset + 1} 的全局设定引用超出图片范围`
    }
    let previousEnd = 0
    for (const [scene, item] of (timeline as unknown[]).entries()) {
      const label = `镜头组 ${offset + 1} 的镜头 ${scene + 1}`
      if (!isRecord(item) || !hasOnlyKeys(item, ['timestamps', 'prompt', 'image_indexes'])) {
        return `${label} 的字段不正确`
      }
      const timestamps = item['timestamps']
      if (!Array.isArray(timestamps) || timestamps.length !== 2) {
        return `${label} 的 timestamps 必须包含开始和结束时间`
      }
      const start: unknown = timestamps[0]
      const end: unknown = timestamps[1]
      if (
        typeof start !== 'number' ||
        typeof end !== 'number' ||
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        start < 0 ||
        end <= start ||
        (scene === 0 && start !== 0) ||
        start < previousEnd
      ) {
        return `${label} 的时间段无效；首镜从 0 开始，各镜头不得重叠`
      }
      previousEnd = end
      const body = item['prompt']
      if (typeof body !== 'string' || body.trim().length === 0) return `${label} 的正文不能为空`
      const indexes = imageIndexes(body)
      if (indexes.some((index) => index < 1 || index > urls.length)) {
        return `${label} 的图片引用超出范围`
      }
      if (JSON.stringify(item['image_indexes']) !== JSON.stringify(indexes)) {
        return `${label} 的 image_indexes 与正文引用不一致`
      }
    }
  }
  return undefined
}

export const resetMockWorkspace = () => {
  for (const timer of timers) clearTimeout(timer)
  timers.clear()
  workspaces.clear()
  workspaceFrames.clear()
  generations.clear()
}

export const workspaceHandlers = [
  http.get('*/mock-frames/:name.png', ({ params }) => {
    const png = FRAME_PNGS[String(params['name'])]
    if (png === undefined) return new HttpResponse(null, { status: 404 })
    const bytes = Uint8Array.from(atob(png), (character) => character.charCodeAt(0))
    return new HttpResponse(bytes, { headers: { 'Content-Type': 'image/png' } })
  }),
  http.get('*/api/conversations/:conversationId/workspace/files', ({ params }) => {
    const files = workspaces.get(String(params['conversationId'])) ?? new Map<string, MockFile>()
    return HttpResponse.json({
      files: [...files].map(([path, file]) => ({
        path,
        sizeBytes: file.content.length,
        updatedAt: file.updatedAt,
        version: file.version,
      })),
    })
  }),

  http.get('*/api/conversations/:conversationId/workspace/file', ({ params, request }) => {
    const path = new URL(request.url).searchParams.get('path') ?? ''
    const file = workspaces.get(String(params['conversationId']))?.get(path)
    if (file === undefined) return HttpResponse.json({ detail: '文件不存在' }, { status: 404 })
    return HttpResponse.json({ file: { content: file.content, path, version: file.version } })
  }),

  // 版本不匹配返回 409，内容结构无效返回 422；mock 不校验媒体地址。
  http.put('*/api/conversations/:conversationId/workspace/file', async ({ params, request }) => {
    const body = (await request.json()) as {
      content: string
      expectedVersion: number
      path: string
    }
    const files = workspaces.get(String(params['conversationId']))
    const file = files?.get(body.path)
    if (files === undefined || file === undefined) {
      return HttpResponse.json({ detail: '文件不存在，任何版本都对不上' }, { status: 409 })
    }
    if (file.version !== body.expectedVersion) {
      return HttpResponse.json(
        { detail: `版本对不上：现在是第 ${file.version} 版` },
        { status: 409 },
      )
    }
    if (body.path === SHOTS_MOCK_PATH) {
      const problem = validateShotsContent(body.content)
      if (problem !== undefined) return HttpResponse.json({ detail: problem }, { status: 422 })
    }
    const written: MockFile = {
      content: body.content,
      updatedAt: new Date().toISOString(),
      version: file.version + 1,
    }
    files.set(body.path, written)
    return HttpResponse.json({
      file: { content: written.content, path: body.path, version: written.version },
    })
  }),

  http.get('*/api/generations/image-models', () =>
    HttpResponse.json({
      default: 'nano_banana_pro',
      items: [
        {
          model: 'nano_banana_pro',
          label: 'Nano Banana Pro',
          aspectRatios: ['1:1', '3:2', '2:3', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'],
          resolutions: ['1k', '2k', '4k'],
          channels: ['dev', 'pro'],
        },
        {
          model: 'seedream_v5_pro',
          label: 'Seedream 5.0 Pro',
          aspectRatios: ['1:1', '3:2', '2:3', '3:4', '4:3', '9:16', '16:9', '21:9'],
          resolutions: ['1k', '2k'],
          channels: [],
        },
      ],
    }),
  ),

  // 视频模型只有 id，允许表照服务端配置。
  http.get('*/api/generations/video-models', () =>
    HttpResponse.json({
      default: 'moyu-seedance-2-5',
      items: ['moyu-seedance-2-0', 'moyu-seedance-2-5', 'wan3.0-video'],
    }),
  ),

  http.get('*/api/generations', ({ request }) => {
    const params = new URL(request.url).searchParams
    const conversationId = params.get('conversationId')
    let items = conversationId === null ? [] : (generations.get(conversationId) ?? [])
    const kind = params.get('kind')
    const shotIndex = params.get('shotIndex')
    const frameNumber = params.get('frameNumber')
    items = items.filter(
      (item) =>
        (kind === null || item.kind === kind) &&
        (shotIndex === null || item.shotIndex === Number(shotIndex)) &&
        (frameNumber === null || item.request['frameNumber'] === Number(frameNumber)),
    )
    items = [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    const before = params.get('before')
    if (before !== null) items = items.slice(items.findIndex((item) => item.id === before) + 1)
    const limit = params.get('limit')
    if (limit !== null) items = items.slice(0, Number(limit))
    return HttpResponse.json({ items })
  }),

  http.post('*/api/generations/image', async ({ request }) => {
    const body = (await request.json()) as ImageGenerationIn
    const created = acceptGeneration({
      kind: 'image',
      prompt: body.prompt,
      request: { ...body },
      conversationId: body.conversationId ?? null,
      shotIndex: body.shotIndex ?? null,
      outputUrl: (workspaceFrames.get(body.conversationId ?? '') ?? DATA_FRAMES).c,
    })
    return HttpResponse.json({ generation: created }, { status: 202 })
  }),

  // 视频那一对端点照上游：提交只回任务号，字段是 snake_case。正文可直接给，也可给 shot 由服务端拼。
  http.post('*/api/generations/video', async ({ request }) => {
    const body = (await request.json()) as VideoGenerationIn
    const prompt =
      body.shot === undefined || body.shot === null ? body.prompt : assembleShotPrompt(body.shot)
    if (typeof prompt !== 'string') {
      return HttpResponse.json({ detail: 'prompt 与 shot 至少传一个' }, { status: 422 })
    }
    const created = acceptGeneration({
      kind: 'video',
      prompt,
      request: { ...body, prompt },
      conversationId: body.conversation_id ?? null,
      shotIndex: body.shot_index ?? null,
      outputUrl: VIDEO_URL,
      watermarkOutputUrl: VIDEO_URL,
    })
    return HttpResponse.json({ task_id: created.id }, { status: 202 })
  }),
]

/** 受理一条生成记录并在固定延迟后把它标成完成，与真实后端的「先受理、后台出结果」同形。 */
function acceptGeneration(spec: {
  kind: 'image' | 'video'
  prompt: string
  request: Record<string, unknown>
  conversationId: string | null
  shotIndex: number | null
  outputUrl: string
  watermarkOutputUrl?: string
}) {
  const created = job({
    createdAt: new Date().toISOString(),
    id: crypto.randomUUID(),
    kind: spec.kind,
    prompt: spec.prompt,
    request: spec.request,
    ...(spec.shotIndex === null ? {} : { shotIndex: spec.shotIndex }),
    status: 'submitted',
  })
  if (spec.conversationId !== null) {
    generations.set(spec.conversationId, [...(generations.get(spec.conversationId) ?? []), created])
  }
  const timer = setTimeout(() => {
    created.outputUrl = spec.outputUrl
    created.watermarkOutputUrl = spec.watermarkOutputUrl ?? null
    created.status = 'completed'
    timers.delete(timer)
  }, VIDEO_DONE_MS)
  timers.add(timer)
  return created
}
