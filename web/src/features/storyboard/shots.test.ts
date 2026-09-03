import { describe, expect, it } from 'vitest'
import {
  firstFrameOfScene,
  latestShotVideos,
  parseShotsDocument,
  runningShots,
  sceneOfFrame,
  shotName,
  shotStatus,
  splitPrompt,
  splitShotTimeline,
  type Shot,
  type ShotGeneration,
} from './shots'

const document = {
  aspectRatio: '9:16',
  shots: [
    { imageUrls: ['a.png', 'b.png'], index: 1, prompt: '开场，她站在门厅 @Image1。', seconds: 6 },
  ],
}

const job = (overrides: Partial<ShotGeneration>): ShotGeneration => ({
  createdAt: '2026-09-01T10:00:00Z',
  kind: 'video',
  outputUrl: 'https://cdn.example/v1.mp4',
  shotIndex: 1,
  status: 'completed',
  ...overrides,
})

describe('parseShotsDocument', () => {
  it('按落文件那份键名解析', () => {
    expect(parseShotsDocument(JSON.stringify(document))).toEqual(document)
  })

  it.each([
    ['不是 JSON', '{ 这不是 JSON'],
    ['根不是对象', '[]'],
    ['缺画幅', JSON.stringify({ shots: [] })],
    [
      '镜头组缺帧列表',
      JSON.stringify({ aspectRatio: '9:16', shots: [{ index: 1, prompt: 'x', seconds: 6 }] }),
    ],
    [
      '帧列表写成字符串',
      JSON.stringify({
        aspectRatio: '9:16',
        shots: [{ imageUrls: 'a.png', index: 1, prompt: 'x', seconds: 6 }],
      }),
    ],
  ])('%s 时解析不出东西，不抛异常', (_case, content) => {
    expect(parseShotsDocument(content)).toBeNull()
  })
})

describe('shotName', () => {
  it('取第一段的第一句，帧记号不算字', () => {
    expect(
      shotName({
        imageUrls: [],
        index: 2,
        prompt: '硬切，她从长椅间走向镜头 @Image2，走到近处停下微笑。第二句。\n第二段',
        seconds: 11,
      }),
    ).toBe('硬切，她从长椅间走向镜头，走到近处停下微笑')
  })

  it('第一段是空行时往下找', () => {
    expect(shotName({ imageUrls: [], index: 3, prompt: '\n  \n收尾镜头', seconds: 4 })).toBe(
      '收尾镜头',
    )
  })

  it('有时间线时取第一镜正文，不拿前言当组名', () => {
    expect(
      shotName({
        imageUrls: [],
        index: 2,
        prompt: ['参考锁定：服装跟住 @Image1。', '[0–4秒｜镜头1]', '她从长椅间走向镜头。'].join(
          '\n',
        ),
        seconds: 11,
      }),
    ).toBe('她从长椅间走向镜头')
  })

  it('整段没有正文就用序号起名', () => {
    expect(shotName({ imageUrls: [], index: 3, prompt: '@Image1 @Image2', seconds: 4 })).toBe(
      '镜头组 3',
    )
  })
})

describe('splitPrompt', () => {
  it('帧记号切成独立段，正文与换行原样留着', () => {
    expect(
      splitPrompt('开场 @Image1，\n收尾 @Image12。').map(({ id: _id, ...segment }) => segment),
    ).toEqual([
      { kind: 'text', text: '开场 ' },
      { kind: 'frame', number: 1 },
      { kind: 'text', text: '，\n收尾 ' },
      { kind: 'frame', number: 12 },
      { kind: 'text', text: '。' },
    ])
  })

  it('每段的 id 各不相同，渲染时当 key 用', () => {
    const ids = splitPrompt('同 @Image1 同 @Image1 同').map((segment) => segment.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('没有帧记号就只有一段正文', () => {
    expect(splitPrompt('只有正文')).toEqual([{ id: 't0', kind: 'text', text: '只有正文' }])
  })
})

describe('latestShotVideos', () => {
  it('每组取最新一条完成的视频', () => {
    const videos = latestShotVideos([
      job({ createdAt: '2026-09-01T09:00:00Z', outputUrl: 'old.mp4' }),
      job({ createdAt: '2026-09-01T11:00:00Z', outputUrl: 'new.mp4' }),
      job({ createdAt: '2026-09-01T12:00:00Z', outputUrl: 'other.mp4', shotIndex: 2 }),
    ])

    expect(videos.get(1)).toBe('new.mp4')
    expect(videos.get(2)).toBe('other.mp4')
  })

  it('没完成的、出图的、没归组的都不算', () => {
    const videos = latestShotVideos([
      job({ status: 'submitted' }),
      job({ kind: 'image', outputUrl: 'frame.png' }),
      job({ shotIndex: null }),
      job({ outputUrl: null }),
    ])

    expect(videos.size).toBe(0)
  })
})

describe('shotStatus', () => {
  it('出过片是成功档，在飞是运行档，都没有是中性', () => {
    const jobs = [job({ shotIndex: 1 }), job({ shotIndex: 2, status: 'submitting' })]
    const videos = latestShotVideos(jobs)
    const running = runningShots(jobs)

    expect(shotStatus(1, videos, running)).toBe('ready')
    expect(shotStatus(2, videos, running)).toBe('running')
    expect(shotStatus(3, videos, running)).toBe('idle')
  })

  it('既有成片又在重出时仍算成功档', () => {
    const jobs = [job({}), job({ createdAt: '2026-09-01T13:00:00Z', status: 'pending' })]
    expect(shotStatus(1, latestShotVideos(jobs), runningShots(jobs))).toBe('ready')
  })
})

const withPrompt = (prompt: string): Shot => ({ imageUrls: [], index: 1, prompt, seconds: 10 })

describe('splitShotTimeline', () => {
  const timeline = splitShotTimeline(
    withPrompt(
      [
        '参考锁定：模特 @Image1 的服装。',
        '剪辑形式：硬切。',
        '',
        '[0–3.5秒｜镜头1]',
        '开场，她提着帆布包走出门厅 @Image1。',
        '',
        '[3.5-9秒｜镜头2]',
        '她走向镜头 @Image2，停下微笑 @Image3。',
        '再看一眼 @Image2。',
      ].join('\n'),
    ),
  )

  it('时间线之前的行归前言，不算镜头', () => {
    expect(timeline.preamble).toBe('参考锁定：模特 @Image1 的服装。\n剪辑形式：硬切。')
    expect(timeline.scenes).toHaveLength(2)
  })

  it('秒数保留小数，全角与半角破折号都认', () => {
    expect(timeline.scenes.map((scene) => [scene.startSeconds, scene.endSeconds])).toEqual([
      [0, 3.5],
      [3.5, 9],
    ])
    expect(timeline.scenes.map((scene) => scene.scene)).toEqual([1, 2])
  })

  it('每镜的帧按出现次序去重', () => {
    expect(timeline.scenes[0]?.frameNumbers).toEqual([1])
    expect(timeline.scenes[1]?.frameNumbers).toEqual([2, 3])
  })

  it('正文仍切成正文段与帧芯片，头部那一行不进正文', () => {
    const kinds = timeline.scenes[0]?.segments.map((segment) => segment.kind)
    expect(kinds).toEqual(['text', 'frame', 'text'])
    expect(timeline.scenes[0]?.segments[0]).toMatchObject({ text: '开场，她提着帆布包走出门厅 ' })
  })

  it('一行头都没有时整段算前言、一个镜头都没有', () => {
    const flat = splitShotTimeline(withPrompt('就是一段话 @Image1，没有时间线。'))
    expect(flat.scenes).toEqual([])
    expect(flat.preamble).toBe('就是一段话 @Image1，没有时间线。')
  })

  it('镜头号重复时两镜各有各的 key', () => {
    const repeated = splitShotTimeline(
      withPrompt(['[0–2秒｜镜头1]', 'A', '[2–4秒｜镜头1]', 'B'].join('\n')),
    )
    const ids = repeated.scenes.map((scene) => scene.id)
    expect(new Set(ids).size).toBe(2)
  })

  it.each([
    ['行首有空白', '  [0–2秒｜镜头1]'],
    ['不写「秒」', '[0–2｜镜头1]'],
    ['用全角方括号与竖线', '【0–2秒|镜头1】'],
  ])('%s 也认得出来', (_case, header) => {
    expect(splitShotTimeline(withPrompt(`${header}\n正文`)).scenes).toHaveLength(1)
  })

  it('行尾还有别的字就不算时间线头', () => {
    expect(splitShotTimeline(withPrompt('[0–2秒｜镜头1] 开场')).scenes).toEqual([])
  })

  it('没写帧的镜头查不出第一帧', () => {
    const bare = splitShotTimeline(withPrompt('[0–2秒｜镜头1]\n只有旁白，没有画面记号。'))
    const scene = bare.scenes[0]
    expect(scene && firstFrameOfScene(scene)).toBeUndefined()
  })

  it('帧反查镜头：第一个写到它的镜头算数', () => {
    expect(sceneOfFrame(timeline, 3)?.scene).toBe(2)
    expect(sceneOfFrame(timeline, 1)?.scene).toBe(1)
    expect(sceneOfFrame(timeline, 9)).toBeUndefined()
  })
})
