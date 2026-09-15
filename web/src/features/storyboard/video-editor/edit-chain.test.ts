import { describe, expect, it } from 'vitest'
import type { GenerationJob } from '../storyboard.api'
import {
  actualEditStart,
  ancestorsOf,
  composeSegments,
  editCountsByRoot,
  layoutSegments,
  locateClock,
  projectEditChain,
  splicePreview,
  type ChainVersion,
} from './edit-chain'

const ROOT_URL = 'https://oss.example/root.mp4'

const job = (spec: Partial<GenerationJob> & { id: string }): GenerationJob => ({
  createdAt: '2026-09-15T10:00:00Z',
  errorMessage: null,
  kind: 'video',
  metadata: null,
  outputUrl: null,
  request: {},
  status: 'completed',
  taskId: null,
  watermarkOutputUrl: null,
  ...spec,
})

const coords = (editId: string, baseJob: string, editStart: number, editEnd: number) => ({
  rootJob: 'root',
  baseJob,
  editId,
  editStart,
  editEnd,
})

const root = job({
  id: 'root',
  outputUrl: ROOT_URL,
  metadata: { path: 'video_shot.json', shot: 2 },
  request: { prompt: '原片' },
})

/** e1 已合成；e2 在 V2 上切片中；e3 编辑结果回来了待预览；e4 生成失败。 */
const chainJobs: GenerationJob[] = [
  job({
    id: 'e1-ref',
    kind: 'clip',
    createdAt: '2026-09-15T10:01:00Z',
    outputUrl: 'https://oss.example/e1-ref.mp4',
    metadata: coords('e1', 'root', 4, 8),
    request: { purpose: 'reference', segments: [{ url: ROOT_URL, start: 4, end: 8 }] },
  }),
  job({
    id: 'e1-video',
    createdAt: '2026-09-15T10:02:00Z',
    outputUrl: 'https://oss.example/e1.mp4',
    metadata: coords('e1', 'root', 3.774, 8),
    request: { prompt: '编辑视频，换成浅灰背景' },
  }),
  job({
    id: 'e1-master',
    kind: 'clip',
    createdAt: '2026-09-15T10:03:00Z',
    outputUrl: 'https://oss.example/m1.mp4',
    metadata: coords('e1', 'root', 3.774, 8),
    request: {
      purpose: 'master',
      segments: [
        { url: ROOT_URL, start: 0, end: 3.774 },
        { url: 'https://oss.example/e1.mp4', start: 0, end: 4.1 },
        { url: ROOT_URL, start: 8, end: 15 },
      ],
    },
  }),
  job({
    id: 'e2-ref',
    kind: 'clip',
    createdAt: '2026-09-15T10:04:00Z',
    status: 'submitted',
    metadata: coords('e2', 'e1-master', 1, 2),
    request: {
      purpose: 'reference',
      segments: [{ url: 'https://oss.example/m1.mp4', start: 1, end: 2 }],
    },
  }),
  job({
    id: 'e3-video',
    createdAt: '2026-09-15T10:05:00Z',
    outputUrl: 'https://oss.example/e3.mp4',
    metadata: coords('e3', 'root', 2.5, 6),
    request: { prompt: '把人物换成侧身' },
  }),
  job({
    id: 'e4-video',
    createdAt: '2026-09-15T10:06:00Z',
    status: 'failed',
    errorMessage: '上游拒绝了这段素材',
    metadata: coords('e4', 'root', 0, 3),
  }),
  // 坐标读不出来的、基底不在链里的，都不算。
  job({ id: 'stray', metadata: { path: 'video_shot.json', shot: 2 } }),
  job({ id: 'orphan', metadata: coords('e9', 'elsewhere', 0, 1), outputUrl: 'x' }),
]

describe('projectEditChain', () => {
  const chain = projectEditChain(root, chainJobs)

  it('根是 V1，合成完的成片按时间接着编号，并记住基于哪一版', () => {
    expect(chain.versions.map((version) => [version.key, version.label, version.mediaUrl])).toEqual(
      [
        ['root', 'V1', ROOT_URL],
        ['e1', 'V2', 'https://oss.example/m1.mp4'],
      ],
    )
    expect(chain.versions[1]?.edit).toMatchObject({ baseKey: 'root', editStart: 3.774, editEnd: 8 })
  })

  it('进行中的编辑按阶段分类、按提交顺序预定版本号，坐标以编辑结果上的实际值为准', () => {
    expect(
      chain.pending.map((edit) => [edit.key, edit.label, edit.base.label, edit.stage, edit.error]),
    ).toEqual([
      ['e2', 'V3', 'V2', 'cutting', undefined],
      ['e3', 'V4', 'V1', 'ready', undefined],
      ['e4', 'V5', 'V1', 'failed', '上游拒绝了这段素材'],
    ])
    expect(chain.pending[1]?.prompt).toBe('把人物换成侧身')
    expect(chain.pending[1]?.coords).toMatchObject({ editStart: 2.5, editEnd: 6 })
  })

  it('来源链从根一路追到当前版本', () => {
    const labels = (from: number) =>
      chain.versions[from] === undefined
        ? []
        : ancestorsOf(chain.versions, chain.versions[from]).map((version) => version.label)
    expect(labels(1)).toEqual(['V1', 'V2'])
    expect(labels(0)).toEqual(['V1'])
  })

  it('待预览的编辑把基底切开、夹进结果，尾段开放到素材结束', () => {
    expect(chain.pending[1]?.preview).toEqual([
      { mediaUrl: ROOT_URL, start: 0, end: 2.5, role: 'base' },
      { mediaUrl: 'https://oss.example/e3.mp4', start: 0, role: 'edited' },
      { mediaUrl: ROOT_URL, start: 6, role: 'base' },
    ])
  })

  it('根没有结果时没有任何版本', () => {
    expect(projectEditChain(job({ id: 'root' }), chainJobs).versions).toEqual([])
  })
})

describe('splicePreview', () => {
  const base: ChainVersion = {
    key: 'root',
    jobId: 'root',
    label: 'V1',
    mediaUrl: ROOT_URL,
    createdAt: '',
    edit: undefined,
  }

  it('从头开始改就没有前段', () => {
    expect(splicePreview(base, { editStart: 0, editEnd: 3 }, 'e')).toEqual([
      { mediaUrl: 'e', start: 0, role: 'edited' },
      { mediaUrl: ROOT_URL, start: 3, role: 'base' },
    ])
  })
})

describe('layoutSegments', () => {
  const preview = splicePreview(
    { key: 'r', jobId: 'r', label: 'V1', mediaUrl: ROOT_URL, createdAt: '', edit: undefined },
    { editStart: 2.5, editEnd: 6 },
    'e',
  )

  it('开放着的段没有时长就排不出来', () => {
    expect(layoutSegments(preview, { [ROOT_URL]: 15 })).toBeUndefined()
    expect(layoutSegments(preview, { [ROOT_URL]: 15, e: null })).toBeUndefined()
  })

  it('时长齐了就排上时钟，合成用的段全是闭区间', () => {
    const laid = layoutSegments(preview, { [ROOT_URL]: 15, e: 3.4 })
    expect(laid?.map((segment) => [segment.at, segment.duration, segment.end])).toEqual([
      [0, 2.5, 2.5],
      [2.5, 3.4, 3.4],
      [5.9, 9, 15],
    ])
    expect(composeSegments(laid ?? [])).toEqual([
      { url: ROOT_URL, start: 0, end: 2.5 },
      { url: 'e', start: 0, end: 3.4 },
      { url: ROOT_URL, start: 6, end: 15 },
    ])
  })

  it('零长的段不占时钟', () => {
    const laid = layoutSegments(
      [
        { mediaUrl: 'a', start: 0, end: 0, role: 'base' },
        { mediaUrl: 'b', start: 1, role: 'edited' },
      ],
      { b: 3 },
    )
    expect(laid).toEqual([{ mediaUrl: 'b', start: 1, end: 3, role: 'edited', at: 0, duration: 2 }])
  })
})

describe('locateClock', () => {
  const laid =
    layoutSegments(
      [
        { mediaUrl: 'a', start: 0, end: 2, role: 'base' },
        { mediaUrl: 'b', start: 0, end: 3, role: 'edited' },
      ],
      {},
    ) ?? []

  it.each([
    [0, { index: 0, offset: 0 }],
    [1.5, { index: 0, offset: 1.5 }],
    [2, { index: 1, offset: 0 }],
    [4.5, { index: 1, offset: 2.5 }],
    [5, { index: 1, offset: 3 }],
    [99, { index: 1, offset: 3 }],
    [-1, { index: 0, offset: 0 }],
  ])('%s 秒落在 %j', (clock, expected) => {
    expect(locateClock(laid, clock)).toEqual(expected)
  })

  it('没有段就没有位置', () => {
    expect(locateClock([], 1)).toBeUndefined()
  })
})

describe('actualEditStart', () => {
  it('结束点准，起点按片段实际时长往前推，推过头就贴 0', () => {
    expect(actualEditStart(8, 4.226)).toBe(3.774)
    expect(actualEditStart(3, 3.5)).toBe(0)
  })
})

describe('editCountsByRoot', () => {
  it('只按 rootJob 数成功的编辑结果，基底不在链里的也算这条根的', () => {
    expect([...editCountsByRoot(chainJobs)]).toEqual([['root', 3]])
  })
})
