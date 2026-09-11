import { appendContentImage, insertContentReference } from './shot-content'
import { describe, expect, it } from 'vitest'
import {
  firstFrameOfScene,
  parseShotsDocument,
  sceneOfFrame,
  shotName,
  splitShotTimeline,
  type Shot,
  type ShotsDocument,
  extractImageIndexes,
  formatShotPrompt,
  formatShotPrompts,
  updateTimelinePrompt,
  validateShot,
} from './shot-document'
import { splitPrompt } from './shots'

const shot: Shot = {
  image_urls: ['a.png', 'b.png'],
  index: 1,
  prompt: {
    global_settings: '  参考锁定：服装保持一致。\n剪辑形式：硬切。\n',
    timeline: [
      {
        timestamps: [0, 3.5],
        prompt: '  开场，她站在门厅 @Image2，转身看向屋内 @Image1。\n',
        image_indexes: [2, 1],
      },
      {
        timestamps: [4.25, 8.5],
        prompt: '走近拍摄鞋面 @Image1。',
        image_indexes: [1],
      },
      {
        timestamps: [8.5, 9],
        prompt: '只有旁白，没有图片引用。',
        image_indexes: [],
      },
    ],
  },
  seconds: 6,
}

const document: ShotsDocument = { aspect_ratio: '9:16', shots: [shot] }

const serializedShot = (overrides: Record<string, unknown>): string =>
  JSON.stringify({ ...document, shots: [{ ...shot, ...overrides }] })

const serializedTimelineItem = (overrides: Record<string, unknown>): string =>
  serializedShot({
    prompt: {
      ...shot.prompt,
      timeline: [{ ...shot.prompt.timeline[0], ...overrides }],
    },
  })

const withBody = (prompt: string, image_indexes: number[] = [], index = 2): Shot => ({
  ...shot,
  index,
  prompt: {
    ...shot.prompt,
    timeline: [{ timestamps: [0, 6], prompt, image_indexes }],
  },
})

describe('parseShotsDocument', () => {
  it('按文件字段读取，保留正文空白、时间空档、小数和独立填写的组时长', () => {
    expect(parseShotsDocument(JSON.stringify(document))).toEqual(document)
  })

  it.each([
    ['不是 JSON', '{ 这不是 JSON'],
    ['根不是对象', '[]'],
    ['缺画幅', JSON.stringify({ shots: [shot] })],
    ['画幅类型错误', JSON.stringify({ ...document, aspect_ratio: 9 })],
    ['缺镜头组列表', JSON.stringify({ aspect_ratio: '9:16' })],
    ['镜头组列表类型错误', JSON.stringify({ ...document, shots: shot })],
    ['镜头组缺编号', serializedShot({ index: undefined })],
    ['镜头组缺时长', serializedShot({ seconds: undefined })],
    ['镜头组缺图片列表', serializedShot({ image_urls: undefined })],
    ['图片列表写成字符串', serializedShot({ image_urls: 'a.png' })],
    ['图片地址类型错误', serializedShot({ image_urls: [1] })],
    ['镜头组缺提示词', serializedShot({ prompt: undefined })],
    ['提示词写成字符串', serializedShot({ prompt: '开场 @Image1。' })],
    ['缺全局设定', serializedShot({ prompt: { timeline: shot.prompt.timeline } })],
    ['全局设定类型错误', serializedShot({ prompt: { ...shot.prompt, global_settings: 1 } })],
    ['缺时间线', serializedShot({ prompt: { global_settings: '保持一致。' } })],
    ['时间线类型错误', serializedShot({ prompt: { ...shot.prompt, timeline: '镜头一' } })],
    ['镜头缺时间戳', serializedTimelineItem({ timestamps: undefined })],
    ['时间戳长度错误', serializedTimelineItem({ timestamps: [0, 2, 3] })],
    ['时间戳含字符串', serializedTimelineItem({ timestamps: [0, '3.5'] })],
    ['镜头缺正文', serializedTimelineItem({ prompt: undefined })],
    ['镜头正文类型错误', serializedTimelineItem({ prompt: 1 })],
    ['镜头缺图片编号', serializedTimelineItem({ image_indexes: undefined })],
    ['图片编号列表类型错误', serializedTimelineItem({ image_indexes: 1 })],
  ])('%s 时返回空结果，不抛异常', (_case, content) => {
    expect(parseShotsDocument(content)).toBeNull()
  })

  it.each([
    ['零编号', [0]],
    ['超出本组图片数', [3]],
    ['小数编号', [1.5]],
    ['字符串编号', ['1']],
  ])('图片引用为%s 时拒绝读取', (_case, image_indexes) => {
    expect(parseShotsDocument(serializedTimelineItem({ image_indexes }))).toBeNull()
  })

  it('每组图片编号独立，同一张图片可以由多个镜头使用', () => {
    const second = withBody('第二组使用自己的首图 @Image1。', [1], 2)
    const multiple = { ...document, shots: [shot, { ...second, image_urls: ['other.png'] }] }

    expect(parseShotsDocument(JSON.stringify(multiple))).toEqual(multiple)
  })

  it('没有任何图片时仍可读取完整镜头组，空数组保持为空', () => {
    const empty: ShotsDocument = {
      ...document,
      shots: [{ ...withBody('只有动作描述，没有图片引用。', [], 1), image_urls: [] }],
    }
    expect(parseShotsDocument(JSON.stringify(empty))).toEqual(empty)
  })

  it.each(['global_settings', 'timeline'] as const)('空图片组拒绝%s 中的悬空引用', (field) => {
    const empty = { ...withBody('无图镜头。', [], 1), image_urls: [] }
    if (field === 'global_settings') empty.prompt.global_settings = '跟住 @Image1。'
    else
      empty.prompt.timeline[0] = {
        timestamps: [0, 6],
        prompt: '跟住 @Image1。',
        image_indexes: [1],
      }
    expect(parseShotsDocument(JSON.stringify({ ...document, shots: [empty] }))).toBeNull()
  })

  it('拒绝正文与派生引用不一致，不在读取时修补', () => {
    expect(parseShotsDocument(serializedTimelineItem({ image_indexes: [1, 2] }))).toBeNull()
  })
})

describe('structured editing', () => {
  it('只更新一段正文和对应引用，保留其它段落、图片与时间值', () => {
    const before = structuredClone(shot)
    const next = updateTimelinePrompt(shot, 1, '  第二镜 @Image2，重复 @Image2。\n')
    expect(shot).toEqual(before)
    expect(next.prompt.timeline[0]).toBe(shot.prompt.timeline[0])
    expect(next.prompt.timeline[2]).toBe(shot.prompt.timeline[2])
    expect(next.prompt.global_settings).toBe(shot.prompt.global_settings)
    expect(next.image_urls).toBe(shot.image_urls)
    expect(next.seconds).toBe(shot.seconds)
    expect(next.prompt.timeline[1]).toEqual({
      ...shot.prompt.timeline[1],
      prompt: '  第二镜 @Image2，重复 @Image2。\n',
      image_indexes: [2],
    })
  })

  it('删除最后一个引用只解除关系，图片和原编号保留', () => {
    const next = updateTimelinePrompt(shot, 0, '这段保留纯文字。')
    expect(next.prompt.timeline[0]?.image_indexes).toEqual([])
    expect(next.image_urls).toEqual(shot.image_urls)
    expect(validateShot(next)).toBeUndefined()
  })

  it('保存前拦截空正文与非法编号，编辑操作保留用户输入', () => {
    const blank = updateTimelinePrompt(shot, 1, ' \n')
    const invalid = updateTimelinePrompt(shot, 1, '人物 @Image9。')
    expect(blank.prompt.timeline[1]?.prompt).toBe(' \n')
    expect(validateShot(blank)).toContain('第 2 镜')
    expect(validateShot(invalid)).toContain('@Image9')
    expect(extractImageIndexes('@Image02 @Image1 @Image2')).toEqual([2, 1])
  })

  it('上传追加新编号，并将引用插到指定的正文选区', () => {
    const body = shot.prompt.timeline[0]?.prompt ?? ''
    const next = appendContentImage(shot, 'scene:1', 'new.png', { text: body, start: 2, end: 4 })
    expect(next.image_urls).toEqual(['a.png', 'b.png', 'new.png'])
    expect(next.prompt.timeline[0]?.prompt).toBe(body.slice(0, 2) + '@Image3' + body.slice(4))
    expect(next.prompt.timeline[0]?.image_indexes).toEqual([3, 2, 1])
    expect(next.prompt.timeline[1]).toBe(shot.prompt.timeline[1])
  })

  it('旧选区不覆盖新文字，追加引用时不重编号其它图片', () => {
    const next = appendContentImage(shot, 'scene:2', 'new.png', {
      text: '旧正文',
      start: 0,
      end: 3,
    })
    expect(next.prompt.timeline[1]?.prompt).toBe('走近拍摄鞋面 @Image1。 @Image3')
    expect(next.prompt.timeline[0]?.prompt).toBe(shot.prompt.timeline[0]?.prompt)
  })

  it('关联已有图片不增加图片槽，空图组添加首图后获得编号1', () => {
    const linked = insertContentReference(shot, 'scene:3', 2)
    expect(linked.image_urls).toBe(shot.image_urls)
    expect(linked.prompt.timeline[2]?.image_indexes).toEqual([2])
    const empty = { ...withBody('纯文字。', [], 1), image_urls: [] }
    const first = appendContentImage(empty, 'scene:1', 'first.png')
    expect(first.image_urls).toEqual(['first.png'])
    expect(first.prompt.timeline[0]?.prompt).toBe('纯文字。 @Image1')
    expect(first.prompt.timeline[0]?.image_indexes).toEqual([1])
  })

  it('文本导出保留原文空白、原始标记和小数时间，批量导出显式分组', () => {
    const original = updateTimelinePrompt(shot, 0, '  原文 @Image02。\n')
    const exported = formatShotPrompt(original)
    expect(exported).toBe(
      `${original.prompt.global_settings}\n\n` +
        '[0–3.5秒｜镜头1]   原文 @Image02。\n\n' +
        '[4.25–8.5秒｜镜头2] 走近拍摄鞋面 @Image1。\n' +
        '[8.5–9秒｜镜头3] 只有旁白，没有图片引用。\n' +
        '不要生成字幕，不要生成背景音乐。',
    )
    expect(formatShotPrompts([original, { ...original, index: 2 }])).toBe(
      `镜头组 1\n${exported}\n\n镜头组 2\n${exported}`,
    )
  })
})

describe('shotName', () => {
  it('取第一镜的首句，帧记号不算标题文字', () => {
    expect(
      shotName(
        withBody('硬切，她从长椅间走向镜头 @Image2，走到近处停下微笑。第二句。\n第二段', [2]),
      ),
    ).toBe('硬切，她从长椅间走向镜头，走到近处停下微笑')
  })

  it('第一镜正文以空行开头时往下找', () => {
    expect(shotName(withBody('\n  \n收尾镜头'))).toBe('收尾镜头')
  })

  it('不拿全局设定当作组名', () => {
    expect(shotName(withBody('她从长椅间走向镜头。'))).toBe('她从长椅间走向镜头')
  })

  it('第一镜只含帧记号时用组序号起名', () => {
    expect(shotName(withBody('@Image1 @Image2', [1, 2], 3))).toBe('镜头组 3')
  })
})

describe('splitShotTimeline', () => {
  const timeline = splitShotTimeline(shot)

  it('全局设定单独显示，保留原始空白且不计入镜头数量', () => {
    expect(timeline.preamble).toBe(shot.prompt.global_settings)
    expect(timeline.scenes).toHaveLength(3)
  })

  it('镜头序号按数组位置生成，起止时间直接取 timestamps', () => {
    expect(timeline.scenes.map((scene) => scene.scene)).toEqual([1, 2, 3])
    expect(timeline.scenes.map((scene) => [scene.startSeconds, scene.endSeconds])).toEqual([
      [0, 3.5],
      [4.25, 8.5],
      [8.5, 9],
    ])
  })

  it('图片顺序来自 image_indexes，首帧不按图片编号排序', () => {
    expect(timeline.scenes.map((scene) => scene.frameNumbers)).toEqual([[2, 1], [1], []])
    expect(timeline.scenes.map(firstFrameOfScene)).toEqual([2, 1, undefined])
  })

  it('正文只拆帧记号，保留行首空格和末尾换行', () => {
    expect(timeline.scenes[0]?.segments.map(({ id: _id, ...segment }) => segment)).toEqual([
      { kind: 'text', text: '  开场，她站在门厅 ' },
      { kind: 'frame', number: 2 },
      { kind: 'text', text: '，转身看向屋内 ' },
      { kind: 'frame', number: 1 },
      { kind: 'text', text: '。\n' },
    ])
  })

  it('正文中的时间线样式文字不创建额外镜头或覆盖结构化时间戳', () => {
    const source = '字幕道具内容：\n[20–25秒｜镜头9]\n这仍是同一镜头的正文 @Image1。'
    const projected = splitShotTimeline(withBody(source, [1]))

    expect(projected.scenes).toHaveLength(1)
    expect(projected.scenes[0]).toMatchObject({ scene: 1, startSeconds: 0, endSeconds: 6 })
    expect(projected.scenes[0]?.segments.map(({ id: _id, ...segment }) => segment)).toEqual(
      splitPrompt(source).map(({ id: _id, ...segment }) => segment),
    )
  })

  it('正文相同的多个镜头仍有独立标识', () => {
    const repeated = splitShotTimeline({
      ...shot,
      prompt: {
        ...shot.prompt,
        timeline: [
          { timestamps: [0, 2], prompt: '同样的镜头 @Image1。', image_indexes: [1] },
          { timestamps: [2, 4], prompt: '同样的镜头 @Image1。', image_indexes: [1] },
        ],
      },
    })
    expect(new Set(repeated.scenes.map((scene) => scene.id)).size).toBe(2)
  })

  it('无帧镜头仍保留正文，且没有首帧', () => {
    const scene = timeline.scenes[2]
    expect(scene?.frameNumbers).toEqual([])
    expect(scene?.segments).toEqual([{ id: 't0', kind: 'text', text: '只有旁白，没有图片引用。' }])
    expect(scene && firstFrameOfScene(scene)).toBeUndefined()
  })

  it('同一帧关联多个镜头时反查首个关联镜头，未知帧没有关联', () => {
    expect(timeline.scenes.filter((scene) => scene.frameNumbers.includes(1))).toHaveLength(2)
    expect(sceneOfFrame(timeline, 1)?.scene).toBe(1)
    expect(sceneOfFrame(timeline, 2)?.scene).toBe(1)
    expect(sceneOfFrame(timeline, 9)).toBeUndefined()
  })
})
