/** 后端场景测试存下的金样，用 vendored schema 逐帧解析并回放：两端形状对不上先在这里红。 */

import { describe, expect, it } from 'vitest'
import delegateTurn from '../../../../contract/transcript/delegate-turn.json'
import toolTurn from '../../../../contract/transcript/tool-turn.json'
import {
  AgentTranscript,
  transcriptOpsEventSchema,
  transcriptResetEventSchema,
  transcriptResponseSchema,
} from './vendor'
import type { TranscriptOpsEvent } from './vendor'

interface Golden {
  ws?: Array<{ type: string; payload: unknown }>
  rest: unknown
}

const SAMPLES: Record<string, Golden> = { 'tool-turn': toolTurn, 'delegate-turn': delegateTurn }

describe.each(Object.keys(SAMPLES))('金样 %s', (name) => {
  const sample = SAMPLES[name] as Golden

  it('REST 一页过 transcript schema', () => {
    const page = transcriptResponseSchema.parse(sample.rest)
    expect(page.agent_id).toBe('main')
    expect(page.items.length).toBeGreaterThan(0)
    expect(page.agents.map((agent) => agent.type)).toContain('main')
    // zod 默认剥掉未声明字段：schema 漏了 triggerPromptId 这里会红，而不是悄悄丢。
    for (const item of page.items) {
      if (item.kind === 'turn') expect(item.triggerPromptId).toBeDefined()
    }
  })

  it.skipIf(sample.ws === undefined)('WS 帧序列逐帧过 schema，回放不缺批、轮数与 REST 一致', () => {
    const frames = sample.ws ?? []
    expect(frames[0]?.type).toBe('transcript.reset')
    // 与 connection.ts 同一种喂法：帧类型和载荷拍平后交给事件 schema。
    const reset = transcriptResetEventSchema.parse({
      type: frames[0]?.type,
      ...(frames[0]?.payload as object),
    })
    expect(reset.agent_id).toBe('main')

    const transcript = new AgentTranscript('main')
    for (const frame of frames.slice(1)) {
      expect(frame.type).toBe('transcript.ops')
      // schema 推出的类型带 `?: T | undefined`，与 exactOptionalPropertyTypes 下的接口不等价，按 vendored 接口收窄。
      const batch = transcriptOpsEventSchema.parse({
        type: frame.type,
        ...(frame.payload as object),
      }) as TranscriptOpsEvent
      const applied = transcript.apply(batch.ops)
      expect(applied.gap).toBeUndefined()
    }
    const page = transcriptResponseSchema.parse(sample.rest)
    expect(transcript.getItems().filter((item) => item.kind === 'turn')).toHaveLength(
      page.items.filter((item) => item.kind === 'turn').length,
    )
  })
})
