/** 文件按完整路径匹配，工具帧按 view 匹配；新增类型仅需登记渲染器。 */

import {
  fileArtifactId,
  frameArtifactId,
  type Artifact,
  type ArtifactEntry,
  type WorkbenchFile,
  type WorkbenchFrame,
} from './artifact'

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
      const entry = this.entries.find(
        (candidate) => 'view' in candidate.match && candidate.match.view === frame.view,
      )
      if (entry === undefined) return []
      const source = {
        kind: 'frame',
        metadata: frame.metadata,
        toolCallId: frame.toolCallId,
        view: frame.view,
      } as const
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
