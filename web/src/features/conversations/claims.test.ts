import { describe, expect, it } from 'vitest'
import type { TranscriptPrompt, TranscriptTurn } from '@/shared/transcript/vendor'
import { claimed } from './claims'

const text = (value: string) => [{ text: value, type: 'text' as const }]

const turn = (
  turnId: string,
  content: string,
  extra: Partial<TranscriptTurn> = {},
): TranscriptTurn => ({
  content: text(content),
  kind: 'turn',
  ordinal: Number(turnId.slice(1)),
  origin: { kind: 'user' },
  state: 'running',
  steps: [],
  turnId,
  ...extra,
})

const prompts = (...items: TranscriptPrompt[]) =>
  new Map(items.map((prompt) => [prompt.promptId, prompt]))

const pending = { content: text('再拆一段'), promptId: 'prm_1' }

describe('claimed', () => {
  it('轮头的 triggerPromptId 对上就认领，内容不同也认', () => {
    expect(
      claimed(pending, [turn('t3', '服务端改写过的内容', { triggerPromptId: 'prm_1' })], prompts()),
    ).toBe(true)
  })

  it('带了 id 却不是它的轮不认领，哪怕内容一样', () => {
    expect(
      claimed(pending, [turn('t2', '再拆一段', { triggerPromptId: 'prm_0' })], prompts()),
    ).toBe(false)
  })

  it('没带 id 的轮退回按内容认', () => {
    expect(claimed(pending, [turn('t2', '再拆一段')], prompts())).toBe(true)
    expect(claimed(pending, [turn('t2', '别的话')], prompts())).toBe(false)
  })

  it('插队进当前轮的那句由带 promptIds 的用户块认领', () => {
    const steered = turn('t2', '第一句', {
      steps: [
        {
          frames: [
            {
              content: text('再拆一段'),
              frameId: 't2.1.f2',
              kind: 'text',
              promptIds: ['prm_1'],
              role: 'user',
              text: '再拆一段',
            },
          ],
          kind: 'step',
          ordinal: 1,
          state: 'running',
          stepId: 't2.1',
          turnId: 't2',
        },
      ],
      triggerPromptId: 'prm_0',
    })
    expect(claimed(pending, [steered], prompts())).toBe(true)
  })

  it('排队中的由队列行显示，到了终态的直接撤', () => {
    const base = { createdAt: '2026-09-05T00:00:00Z', promptId: 'prm_1' }
    expect(claimed(pending, [], prompts({ ...base, status: 'queued' }))).toBe(true)
    expect(claimed(pending, [], prompts({ ...base, status: 'aborted' }))).toBe(true)
    expect(claimed(pending, [], prompts({ ...base, status: 'running' }))).toBe(false)
  })
})
