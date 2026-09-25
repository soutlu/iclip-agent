import { describe, expect, it } from 'vitest'
import { makeGenerationJob } from '@/testing/generation-job'
import type { GenerationJob } from '../storyboard.api'
import {
  ancestorsOf,
  editCountsByRoot,
  layoutSegments,
  locateClock,
  projectEditChain,
  splicePreview,
  type ChainVersion,
  type EditStage,
} from './edit-chain'

const ROOT_URL = 'https://oss.example/root.mp4'
const EDITED_URL = 'https://oss.example/edited.mp4'

const at = (time: string) => `2026-09-15T${time}Z`

const job = (spec: Partial<GenerationJob> & { id: string }): GenerationJob =>
  makeGenerationJob({ createdAt: at('10:00:00'), ...spec })

/** 编辑段：原作号一律指根，来源是这次的基底（根或某次合成）；区间按秒给。 */
const segment = (
  id: string,
  source: string,
  [start, end]: [number, number],
  spec: Partial<GenerationJob> = {},
): GenerationJob =>
  job({
    id,
    rootJobId: 'root',
    sourceJobId: source,
    rangeStartMs: start * 1000,
    rangeEndMs: end * 1000,
    ...spec,
  })

/** 合成：来源是它拼回去的那条编辑段。 */
const composite = (id: string, source: string, spec: Partial<GenerationJob> = {}): GenerationJob =>
  job({ id, operation: 'compose', rootJobId: 'root', sourceJobId: source, ...spec })

const root = job({
  id: 'root',
  outputUrl: ROOT_URL,
  shotIndex: 2,
  request: { prompt: '原片' },
})

/** e1 已合成成 V2；e2 在 V2 上切片中；e3 编辑结果回来了待预览；e4 生成失败。 */
const chainJobs: GenerationJob[] = [
  segment('e1', 'root', [3.774, 8], {
    createdAt: at('10:01:00'),
    outputUrl: 'https://oss.example/e1.mp4',
    request: { prompt: '编辑视频，换成浅灰背景' },
  }),
  composite('m1', 'e1', {
    createdAt: at('10:02:00'),
    finishedAt: at('10:03:00'),
    outputUrl: 'https://oss.example/m1.mp4',
  }),
  segment('e2', 'm1', [1, 2], { createdAt: at('10:04:00'), status: 'submitting' }),
  segment('e3', 'root', [2.5, 6], {
    createdAt: at('10:05:00'),
    outputUrl: 'https://oss.example/e3.mp4',
    request: { prompt: '把人物换成侧身' },
  }),
  segment('e4', 'root', [0, 3], {
    createdAt: at('10:06:00'),
    status: 'failed',
    errorMessage: '上游拒绝了这段素材',
  }),
  // 没有来源的视频不是编辑段，不算。
  job({ id: 'stray', shotIndex: 2 }),
]

describe('projectEditChain', () => {
  const chain = projectEditChain(root, chainJobs)

  it('根是 V1，完成的合成接着编号，键跟着它的编辑段，并记住基于哪一版、改了哪一段', () => {
    expect(
      chain.versions.map((version) => [
        version.key,
        version.jobId,
        version.label,
        version.mediaUrl,
      ]),
    ).toEqual([
      ['root', 'root', 'V1', ROOT_URL],
      ['e1', 'm1', 'V2', 'https://oss.example/m1.mp4'],
    ])
    expect(chain.versions[1]?.edit).toEqual({ baseKey: 'root', start: 3.774, end: 8 })
  })

  it('进行中的编辑按提交顺序预定版本号，基底按记录 id 找，区间取编辑段上记的实际值', () => {
    expect(
      chain.pending.map((edit) => [edit.key, edit.label, edit.base.label, edit.stage, edit.error]),
    ).toEqual([
      ['e2', 'V3', 'V2', 'cutting', undefined],
      ['e3', 'V4', 'V1', 'ready', undefined],
      ['e4', 'V5', 'V1', 'failed', '上游拒绝了这段素材'],
    ])
    expect(chain.pending[1]?.prompt).toBe('把人物换成侧身')
    expect(chain.pending[1]?.range).toEqual({ start: 2.5, end: 6 })
  })

  it('待预览的编辑把基底切开、夹进结果，尾段开放到素材结束', () => {
    expect(chain.pending[1]?.preview).toEqual([
      { mediaUrl: ROOT_URL, start: 0, end: 2.5, role: 'base' },
      { mediaUrl: 'https://oss.example/e3.mp4', start: 0, role: 'edited' },
      { mediaUrl: ROOT_URL, start: 6, role: 'base' },
    ])
  })

  it('基于某次合成的再次编辑，合成后记着基于那一版；来源链从根一路追到当前版本', () => {
    const { versions } = projectEditChain(root, [
      ...chainJobs.slice(0, 2),
      segment('e2', 'm1', [1, 2], { createdAt: at('10:04:00'), outputUrl: 'e2.mp4' }),
      composite('m2', 'e2', {
        createdAt: at('10:05:00'),
        finishedAt: at('10:06:00'),
        outputUrl: 'm2.mp4',
      }),
    ])
    expect(versions.map((version) => [version.label, version.edit?.baseKey])).toEqual([
      ['V1', undefined],
      ['V2', 'root'],
      ['V3', 'e1'],
    ])
    const labels = (from: ChainVersion | undefined) =>
      from === undefined ? [] : ancestorsOf(versions, from).map((version) => version.label)
    expect(labels(versions[2])).toEqual(['V1', 'V2', 'V3'])
    expect(labels(versions[0])).toEqual(['V1'])
  })

  it('完成的合成按完成时刻编号，不看提交先后；缺完成时刻的按创建时刻排', () => {
    const { versions } = projectEditChain(root, [
      segment('slow', 'root', [0, 1], { createdAt: at('10:01:00'), outputUrl: 'slow.mp4' }),
      composite('slow-m', 'slow', {
        createdAt: at('10:02:00'),
        finishedAt: at('10:09:00'),
        outputUrl: 'slow-m.mp4',
      }),
      segment('fast', 'root', [1, 2], { createdAt: at('10:03:00'), outputUrl: 'fast.mp4' }),
      composite('fast-m', 'fast', {
        createdAt: at('10:04:00'),
        finishedAt: at('10:05:00'),
        outputUrl: 'fast-m.mp4',
      }),
      segment('undated', 'root', [2, 3], { createdAt: at('10:05:30'), outputUrl: 'undated.mp4' }),
      composite('undated-m', 'undated', {
        createdAt: at('10:07:00'),
        finishedAt: null,
        outputUrl: 'undated-m.mp4',
      }),
    ])
    expect(versions.map((version) => [version.label, version.jobId])).toEqual([
      ['V1', 'root'],
      ['V2', 'fast-m'],
      ['V3', 'undated-m'],
      ['V4', 'slow-m'],
    ])
  })

  it('重新合成只认最近发起的那一次', () => {
    const edited = segment('e5', 'root', [1, 4], {
      createdAt: at('10:07:00'),
      outputUrl: EDITED_URL,
    })
    const failed = composite('m5-failed', 'e5', {
      createdAt: at('10:08:00'),
      finishedAt: at('10:09:00'),
      status: 'failed',
      errorMessage: '取不到素材',
    })

    const running = projectEditChain(root, [
      composite('m5', 'e5', { createdAt: at('10:10:00'), status: 'submitting' }),
      failed,
      edited,
    ])
    expect(running.pending.map((edit) => [edit.key, edit.stage, edit.master?.id])).toEqual([
      ['e5', 'composing', 'm5'],
    ])

    const done = projectEditChain(root, [
      composite('m5', 'e5', {
        createdAt: at('10:10:00'),
        finishedAt: at('10:11:00'),
        outputUrl: 'm5.mp4',
      }),
      failed,
      edited,
    ])
    expect(done.versions.map((version) => [version.key, version.jobId])).toEqual([
      ['root', 'root'],
      ['e5', 'm5'],
    ])
    expect(done.pending).toEqual([])
  })

  const stageCases: [
    string,
    Partial<GenerationJob>,
    Partial<GenerationJob> | undefined,
    EditStage,
    string | undefined,
  ][] = [
    ['编辑段还在排队', { status: 'pending' }, undefined, 'cutting', undefined],
    ['服务端在切片、交给模型', { status: 'submitting' }, undefined, 'cutting', undefined],
    ['上游在生成', { status: 'submitted' }, undefined, 'generating', undefined],
    ['编辑结果回来了', { outputUrl: EDITED_URL }, undefined, 'ready', undefined],
    [
      '编辑段失败',
      { status: 'failed', errorMessage: '起点超出基底' },
      undefined,
      'failed',
      '起点超出基底',
    ],
    ['合成在跑', { outputUrl: EDITED_URL }, { status: 'submitting' }, 'composing', undefined],
    ['合成失败', { outputUrl: EDITED_URL }, { status: 'failed' }, 'failed', '合成失败'],
  ]

  it.each(stageCases)('%s', (_name, segmentSpec, compositeSpec, stage, error) => {
    const { pending } = projectEditChain(root, [
      ...(compositeSpec === undefined
        ? []
        : [composite('m', 'e', { createdAt: at('10:02:00'), ...compositeSpec })]),
      segment('e', 'root', [1, 3], { createdAt: at('10:01:00'), ...segmentSpec }),
    ])
    expect(pending.map((edit) => [edit.stage, edit.error])).toEqual([[stage, error]])
  })

  it('基底不在链里的编辑与合成都不展示', () => {
    const orphaned = projectEditChain(root, [
      segment('orphan', 'elsewhere', [0, 1], { outputUrl: 'orphan.mp4' }),
      composite('orphan-m', 'orphan', { finishedAt: at('10:01:00'), outputUrl: 'orphan-m.mp4' }),
      segment('orphan-running', 'elsewhere', [0, 1], { status: 'submitted' }),
    ])
    expect(orphaned.versions.map((version) => version.key)).toEqual(['root'])
    expect(orphaned.pending).toEqual([])
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
    expect(splicePreview(base, { start: 0, end: 3 }, 'e')).toEqual([
      { mediaUrl: 'e', start: 0, role: 'edited' },
      { mediaUrl: ROOT_URL, start: 3, role: 'base' },
    ])
  })
})

describe('layoutSegments', () => {
  const preview = splicePreview(
    { key: 'r', jobId: 'r', label: 'V1', mediaUrl: ROOT_URL, createdAt: '', edit: undefined },
    { start: 2.5, end: 6 },
    'e',
  )

  it('开放着的段没有时长就排不出来', () => {
    expect(layoutSegments(preview, { [ROOT_URL]: 15 })).toBeUndefined()
    expect(layoutSegments(preview, { [ROOT_URL]: 15, e: null })).toBeUndefined()
  })

  it('时长齐了就排上时钟，开放的段按素材时长闭合', () => {
    const laid = layoutSegments(preview, { [ROOT_URL]: 15, e: 3.4 })
    expect(laid?.map((segment) => [segment.at, segment.duration, segment.end])).toEqual([
      [0, 2.5, 2.5],
      [2.5, 3.4, 3.4],
      [5.9, 9, 15],
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

describe('editCountsByRoot', () => {
  it('只数这条根名下完成的编辑段：合成不另算，基底不在链里的也算', () => {
    const jobs = [...chainJobs, segment('orphan', 'elsewhere', [0, 1], { outputUrl: 'x' })]
    expect([...editCountsByRoot(jobs)]).toEqual([['root', 3]])
  })
})
