/** 文件按完整路径匹配，工具帧按 view 或 display.kind 匹配，工作区有文件即匹配；新增类型仅需登记渲染器。 */

import {
  fileArtifactId,
  frameArtifactId,
  WORKSPACE_ARTIFACT_ID,
  type Artifact,
  type ArtifactEntry,
  type FrameArtifactSource,
  type WorkbenchFile,
  type WorkbenchFrame,
} from './artifact'

const displayKindOf = (display: unknown): string | undefined => {
  if (typeof display !== 'object' || display === null) return undefined
  const kind = (display as { kind?: unknown }).kind
  return typeof kind === 'string' ? kind : undefined
}

const matchesFrame = (entry: ArtifactEntry, frame: WorkbenchFrame): boolean =>
  ('view' in entry.match && entry.match.view === frame.view) ||
  ('displayKind' in entry.match && entry.match.displayKind === displayKindOf(frame.display))

/** 按路径或工作区命中的类型不随某张工具卡来去，菜单里常驻。 */
export const isStanding = (entry: ArtifactEntry): boolean =>
  'path' in entry.match || 'workspace' in entry.match

export class ArtifactRegistry {
  private readonly entries: ArtifactEntry[] = []

  register(entry: ArtifactEntry): void {
    this.entries.push(entry)
  }

  resolve(type: string): ArtifactEntry | undefined {
    return this.entries.find((entry) => entry.type === type)
  }

  autoOpens(type: string): boolean {
    return this.resolve(type)?.autoOpen ?? false
  }

  /** 常驻类型按登记顺序；折叠态菜单据此列行，没有产物的行灰着并给出 empty 说明。 */
  standing(): ArtifactEntry[] {
    return this.entries.filter(isStanding)
  }

  matchFiles(files: readonly WorkbenchFile[]): Artifact[] {
    return files.flatMap((file) => {
      const entry = this.entries.find(
        (candidate) => 'path' in candidate.match && candidate.match.path === file.path,
      )
      if (entry === undefined) return []
      const source = { kind: 'file', path: file.path, version: file.version } as const
      return [
        { id: fileArtifactId(file.path), source, title: entry.title(source), type: entry.type },
      ]
    })
  }

  matchWorkspace(files: readonly WorkbenchFile[]): Artifact[] {
    const entry = this.entries.find((candidate) => 'workspace' in candidate.match)
    if (entry === undefined || files.length === 0) return []
    const source = { fileCount: files.length, kind: 'workspace' } as const
    return [{ id: WORKSPACE_ARTIFACT_ID, source, title: entry.title(source), type: entry.type }]
  }

  matchFrames(frames: readonly WorkbenchFrame[]): Artifact[] {
    return frames.flatMap((frame) => {
      const entry = this.entries.find((candidate) => matchesFrame(candidate, frame))
      if (entry === undefined) return []
      const source: FrameArtifactSource = {
        kind: 'frame',
        metadata: frame.metadata,
        toolCallId: frame.toolCallId,
        view: frame.view,
        ...(frame.display === undefined ? {} : { display: frame.display }),
        ...(frame.agentRefs === undefined ? {} : { agentRefs: frame.agentRefs }),
      }
      return [
        {
          id: frameArtifactId(frame.toolCallId),
          source,
          title: entry.title(source),
          type: entry.type,
        },
      ]
    })
  }
}

/** 三个来源合成一份列表：按路径命中的文件、整个工作区、工具帧。 */
export const composeArtifacts = (
  registry: ArtifactRegistry,
  files: readonly WorkbenchFile[],
  frames: readonly WorkbenchFrame[],
): Artifact[] => [
  ...registry.matchFiles(files),
  ...registry.matchWorkspace(files),
  ...registry.matchFrames(frames),
]

/** 优先选择请求的产物，其次为首个 autoOpen 类型；都没有就不选，宿主给选择页。 */
export const pickArtifact = (
  registry: ArtifactRegistry,
  artifacts: readonly Artifact[],
  requestedId: string | undefined,
): Artifact | undefined =>
  artifacts.find((artifact) => artifact.id === requestedId) ??
  artifacts.find((artifact) => registry.autoOpens(artifact.type))
