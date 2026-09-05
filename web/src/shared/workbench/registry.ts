/** 文件按完整路径匹配，工具帧按 view 或 display.kind 匹配；新增类型仅需登记渲染器。 */

import {
  fileArtifactId,
  frameArtifactId,
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

export const composeArtifacts = (
  registry: ArtifactRegistry,
  files: readonly WorkbenchFile[],
  frames: readonly WorkbenchFrame[],
): Artifact[] => [...registry.matchFiles(files), ...registry.matchFrames(frames)]

/** 优先选择请求的产物，其次为首个 autoOpen 类型，最后为列表首项。 */
export const pickArtifact = (
  registry: ArtifactRegistry,
  artifacts: readonly Artifact[],
  requestedId: string | undefined,
): Artifact | undefined =>
  artifacts.find((artifact) => artifact.id === requestedId) ??
  artifacts.find((artifact) => registry.autoOpens(artifact.type)) ??
  artifacts[0]
