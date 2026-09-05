import { describe, expect, it } from 'vitest'
import type { TranscriptFrame, TranscriptStep } from '@/shared/transcript/vendor'
import {
  formatActivityDuration,
  groupTurnEntries,
  runHistoryMs,
  summarizeDone,
  summarizeRunning,
  type TurnEntry,
} from './activity-group'

const step: TranscriptStep = {
  endedAt: '2026-08-31T01:00:20Z',
  frames: [],
  kind: 'step',
  ordinal: 1,
  startedAt: '2026-08-31T01:00:00Z',
  state: 'completed',
  stepId: 't1.1',
  turnId: 't1',
}

const entry = (frame: TranscriptFrame): TurnEntry => ({ frame, step })

const timelessStep: TranscriptStep = (() => {
  const bare = { ...step }
  delete bare.startedAt
  delete bare.endedAt
  return bare
})()

const thinking = (id: string): TranscriptFrame => ({
  frameId: id,
  kind: 'thinking',
  text: '想',
})

const tool = (
  id: string,
  operation: 'read' | 'write' | 'edit' | 'glob' | 'grep' | undefined,
  state: 'running' | 'done' | 'error' = 'done',
): TranscriptFrame => ({
  display:
    operation === undefined
      ? { kind: 'generic', summary: '出镜头帧' }
      : { kind: 'file_io', operation, path: 'shots/storyboard.md' },
  frameId: id,
  kind: 'tool',
  name: 'x',
  state,
  toolCallId: id,
})

const text = (id: string, role: 'assistant' | 'user' = 'assistant'): TranscriptFrame =>
  role === 'user'
    ? { content: [{ text: '字', type: 'text' }], frameId: id, kind: 'text', role, text: '字' }
    : { frameId: id, kind: 'text', role, text: '字' }

describe('groupTurnEntries', () => {
  it('连续的思考与工具折成一叠；正文打断一叠', () => {
    const nodes = groupTurnEntries([
      entry(text('u1', 'user')),
      entry(thinking('f1')),
      entry(tool('f2', 'grep')),
      entry(tool('f3', 'write')),
      entry(text('a1')),
      entry(tool('f4', 'read')),
    ])

    expect(nodes.map((node) => node.kind)).toEqual(['entry', 'run', 'entry', 'entry'])
    const run = nodes[1]
    if (run?.kind !== 'run') throw new Error('应折成一叠')
    expect(run.items.map((item) => item.frame.frameId)).toEqual(['f1', 'f2', 'f3'])
  })

  it('派出了子代理的卡不进活动组，「查看」入口不能被折叠藏住', () => {
    const delegated: TranscriptFrame = {
      agentRefs: [{ agentId: 'run-child', role: 'child' }],
      display: { agent_name: 'shot-writer', kind: 'agent_call', prompt: '写三个镜头' },
      frameId: 'f2',
      kind: 'tool',
      name: 'delegate_task',
      state: 'done',
      toolCallId: 'f2',
    }

    const nodes = groupTurnEntries([
      entry(thinking('f1')),
      entry(delegated),
      entry(tool('f3', 'read')),
    ])

    expect(nodes.map((node) => node.kind)).toEqual(['entry', 'entry', 'entry'])
  })

  it('单个工具不折；没有工具的纯思考连续块也不折', () => {
    expect(groupTurnEntries([entry(tool('f1', 'read'))])[0]?.kind).toBe('entry')
    expect(
      groupTurnEntries([entry(thinking('f1')), entry(thinking('f2'))]).map((node) => node.kind),
    ).toEqual(['entry', 'entry'])
  })
})

describe('summarizeDone', () => {
  it('按类别聚合计数、保持出现顺序，失败缀危险子句，尾巴挂时长', () => {
    const clauses = summarizeDone(
      [
        entry(thinking('f1')),
        entry(tool('f2', 'grep')),
        entry(tool('f3', 'grep')),
        entry(tool('f4', 'write')),
        entry(tool('f5', undefined, 'error')),
        entry(tool('f6', undefined)),
      ],
      191_000,
    )

    expect(clauses.map((clause) => clause.text)).toEqual([
      '搜索了 2 个模式',
      '写入了 1 个文件',
      '出镜头帧 ×2',
      '（1 失败）',
      '3m11s',
    ])
    expect(clauses[3]?.tone).toBe('danger')
    expect(clauses[4]?.tone).toBe('faint')
  })
})

describe('summarizeRunning', () => {
  it('当前子句当头，已完成的类别弱化带「已」，尾巴挂实时时长', () => {
    const clauses = summarizeRunning(
      [entry(thinking('f1')), entry(tool('f2', 'grep')), entry(tool('f3', 'read', 'running'))],
      'f3',
      20_000,
    )

    expect(clauses.map((clause) => clause.text)).toEqual([
      '正在读取 shots/storyboard.md',
      '已搜索了 1 个模式',
      '20s',
    ])
  })

  it('直播块是思考时当前子句是「思考中…」', () => {
    const clauses = summarizeRunning([entry(thinking('f1')), entry(tool('f2', 'grep'))], 'f1', 0)
    expect(clauses[0]?.text).toBe('思考中…')
  })
})

describe('formatActivityDuration / runHistoryMs', () => {
  it('时长格式：20s、3m11s、1h2m、0 不出字', () => {
    expect(formatActivityDuration(0)).toBe('')
    expect(formatActivityDuration(400)).toBe('')
    expect(formatActivityDuration(20_000)).toBe('20s')
    expect(formatActivityDuration(191_000)).toBe('3m11s')
    expect(formatActivityDuration(3_600_000)).toBe('1h')
    expect(formatActivityDuration(3_720_000)).toBe('1h2m')
  })

  it('历史一叠的时长取成员步骤的最早开始与最晚结束', () => {
    expect(runHistoryMs([entry(thinking('f1')), entry(tool('f2', 'grep'))])).toBe(20_000)
    expect(runHistoryMs([{ frame: thinking('f3'), step: timelessStep }])).toBeUndefined()
  })
})
