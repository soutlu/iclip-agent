import { describe, expect, it } from 'vitest'
import { phaseOfStatus } from './shots'

describe('phaseOfStatus', () => {
  it.each([
    ['pending', 'queued'],
    ['submitting', 'running'],
    ['submitted', 'running'],
    ['completed', 'done'],
    ['failed', 'failed'],
  ])('%s 给人看是 %s', (status, phase) => {
    expect(phaseOfStatus(status)).toBe(phase)
  })
})
