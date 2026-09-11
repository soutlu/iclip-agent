import { describe, expect, it } from 'vitest'
import { workbenchRegistry } from './workbench-registry'

describe('分镜产物注册', () => {
  it('仅按完整文件路径匹配统一分镜入口，不需要 Agent 信息', () => {
    const artifacts = workbenchRegistry.matchFiles([
      { path: 'video_shot.json', version: 2 },
      { path: 'nested/video_shot.json', version: 1 },
      { path: 'storyboard.md', version: 1 },
    ])
    expect(artifacts.map(({ id, type }) => ({ id, type }))).toEqual([
      { id: 'file:video_shot.json', type: 'storyboard' },
    ])
    expect(workbenchRegistry.autoOpens('storyboard')).toBe(true)
  })
})
