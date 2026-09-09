import { describe, expect, it } from 'vitest'
import type { ArtifactEntry } from './artifact'
import { ArtifactRegistry, composeArtifacts, pickArtifact } from './registry'

const Placeholder = () => null

const shotsEntry: ArtifactEntry = {
  autoOpen: true,
  component: Placeholder,
  empty: 'agent 交付分镜后出现',
  icon: 'grid',
  label: '分镜',
  match: { path: 'video_shot.json' },
  title: () => '分镜',
  type: 'storyboard',
}

const gridEntry: ArtifactEntry = {
  autoOpen: false,
  component: Placeholder,
  icon: 'image',
  label: '媒体墙',
  match: { view: 'media_grid' },
  title: (source) => (source.kind === 'frame' ? `媒体墙 ${source.toolCallId}` : '媒体墙'),
  type: 'media-grid',
}

const workspaceEntry: ArtifactEntry = {
  autoOpen: false,
  component: Placeholder,
  empty: '还没有文件',
  icon: 'folder',
  label: '文件',
  match: { workspace: true },
  title: () => '文件',
  type: 'workspace',
}

const registryWith = (...entries: ArtifactEntry[]) => {
  const registry = new ArtifactRegistry()
  for (const entry of entries) registry.register(entry)
  return registry
}

describe('ArtifactRegistry', () => {
  it('文件按路径命中，id 是 file:<path>', () => {
    const artifacts = registryWith(shotsEntry).matchFiles([
      { path: 'video_shot.json', version: 3 },
      { path: 'frames/extraction.json', version: 1 },
    ])

    expect(artifacts).toEqual([
      {
        id: 'file:video_shot.json',
        source: { kind: 'file', path: 'video_shot.json', version: 3 },
        title: '分镜',
        type: 'storyboard',
      },
    ])
  })

  it('工具帧按 view 命中，id 是 frame:<toolCallId>', () => {
    const artifacts = registryWith(gridEntry).matchFrames([
      { metadata: { items: [] }, toolCallId: 'call_frames', view: 'media_grid' },
      { toolCallId: 'call_other', view: 'file_io' },
    ])

    expect(artifacts).toEqual([
      {
        id: 'frame:call_frames',
        source: {
          kind: 'frame',
          metadata: { items: [] },
          toolCallId: 'call_frames',
          view: 'media_grid',
        },
        title: '媒体墙 call_frames',
        type: 'media-grid',
      },
    ])
  })

  it('工具帧按 display.kind 命中，来源带上 display 与 agentRefs', () => {
    const agentEntry: ArtifactEntry = {
      autoOpen: false,
      component: Placeholder,
      icon: 'agent',
      label: '派活',
      match: { displayKind: 'agent_call' },
      title: () => '派活',
      type: 'sub-agent',
    }
    const display = { agent_name: 'shot-writer', kind: 'agent_call', prompt: '写三个镜头' }

    const artifacts = registryWith(agentEntry).matchFrames([
      { agentRefs: [{ agentId: 'run-1' }], display, toolCallId: 'call_d1', view: 'generic' },
      { display: { kind: 'file_io' }, toolCallId: 'call_r', view: 'generic' },
    ])

    expect(artifacts).toEqual([
      {
        id: 'frame:call_d1',
        source: {
          agentRefs: [{ agentId: 'run-1' }],
          display,
          kind: 'frame',
          metadata: undefined,
          toolCallId: 'call_d1',
          view: 'generic',
        },
        title: '派活',
        type: 'sub-agent',
      },
    ])
  })

  it('工作区有文件就是一件产物，一份文件都没有就没有', () => {
    const registry = registryWith(workspaceEntry)

    expect(registry.matchWorkspace([{ path: 'video/a.md', version: 1 }])).toEqual([
      {
        id: 'workspace',
        source: { fileCount: 1, kind: 'workspace' },
        title: '文件',
        type: 'workspace',
      },
    ])
    expect(registry.matchWorkspace([])).toEqual([])
  })

  it('三个来源合成一份列表：按路径命中的文件、工作区、工具帧', () => {
    const registry = registryWith(shotsEntry, workspaceEntry, gridEntry)

    const artifacts = composeArtifacts(
      registry,
      [{ path: 'video_shot.json', version: 1 }],
      [{ toolCallId: 'call_frames', view: 'media_grid' }],
    )

    expect(artifacts.map((artifact) => artifact.id)).toEqual([
      'file:video_shot.json',
      'workspace',
      'frame:call_frames',
    ])
  })

  it('常驻类型是按路径与按工作区命中的那些，按登记顺序给', () => {
    const registry = registryWith(gridEntry, workspaceEntry, shotsEntry)

    expect(registry.standing().map((entry) => entry.type)).toEqual(['workspace', 'storyboard'])
  })

  it('没登记过的类型解析不出渲染器', () => {
    expect(registryWith(shotsEntry).resolve('media-grid')).toBeUndefined()
  })
})

describe('pickArtifact', () => {
  const registry = registryWith(shotsEntry, gridEntry)
  const artifacts = composeArtifacts(
    registry,
    [{ path: 'video_shot.json', version: 1 }],
    [{ toolCallId: 'call_frames', view: 'media_grid' }],
  )

  it('地址里点名了就选那件', () => {
    expect(pickArtifact(registry, artifacts, 'frame:call_frames')?.id).toBe('frame:call_frames')
  })

  it('没点名就选第一件 autoOpen 的，哪怕它不在最前', () => {
    const reversed = [...artifacts].reverse()
    expect(pickArtifact(registry, reversed, undefined)?.id).toBe('file:video_shot.json')
  })

  it('点名的那件已经没了就退回 autoOpen', () => {
    expect(pickArtifact(registry, artifacts, 'file:gone.json')?.id).toBe('file:video_shot.json')
  })

  it('一件 autoOpen 都没有就不替用户挑，宿主给选择页', () => {
    const onlyFrames = composeArtifacts(
      registry,
      [],
      [{ toolCallId: 'call_frames', view: 'media_grid' }],
    )
    expect(pickArtifact(registry, onlyFrames, undefined)).toBeUndefined()
  })

  it('一件都没有时选不出东西', () => {
    expect(pickArtifact(registry, [], undefined)).toBeUndefined()
  })
})
