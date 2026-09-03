/**
 * 产物类型注册表：把两个来源各过一遍登记，合成产物列表。
 *
 * 匹配只有两种口径——文件按路径全等，工具帧按 `view` 全等。加一种产物类型就是多登记一条，
 * 宿主与已有渲染器都不用改。
 */

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

  /** 这个类型归谁画。没登记过就是 undefined，宿主据此画「不认识的产物」。 */
  resolve(type: string): ArtifactEntry | undefined {
    return this.entries.find((entry) => entry.type === type)
  }

  /** 这个类型打开面板时要不要默认选中。 */
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

/**
 * 两个来源合成一份列表：文件在前，工具帧按到达次序接在后面。
 *
 * @param registry - 产物类型注册表。
 * @param files - 工作区文件列表。
 * @param frames - transcript 里已完成、带 `view` 的工具帧。
 * @returns 合成后的产物列表。
 */
export const composeArtifacts = (
  registry: ArtifactRegistry,
  files: readonly WorkbenchFile[],
  frames: readonly WorkbenchFrame[],
): Artifact[] => [...registry.matchFiles(files), ...registry.matchFrames(frames)]

/**
 * 选中哪一件：地址里点名的那件优先，没有就选第一件 `autoOpen` 的，再没有就第一件。
 *
 * @param registry - 产物类型注册表。
 * @param artifacts - 合成后的产物列表。
 * @param requestedId - 地址里的 `artifact` 查询参数。
 * @returns 选中的产物；一件都没有时为 undefined。
 */
export const pickArtifact = (
  registry: ArtifactRegistry,
  artifacts: readonly Artifact[],
  requestedId: string | undefined,
): Artifact | undefined =>
  artifacts.find((artifact) => artifact.id === requestedId) ??
  artifacts.find((artifact) => registry.autoOpens(artifact.type)) ??
  artifacts[0]
