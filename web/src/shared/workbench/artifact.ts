/**
 * 产物面板的类型面：一件产物长什么样，谁来画它。
 *
 * 产物有两个来源——工作区文件与工具帧上给人看的结果（ADR-0009 决策 1）。宿主只按这份类型
 * 分派，不认识任何具体产物类型；具体类型由 `app/` 层登记进注册表。
 */

import type { ComponentType } from 'react'

/** 工作区文件来源。`version` 变了内容才变，渲染器据此判断要不要重读。 */
export interface FileArtifactSource {
  kind: 'file'
  path: string
  version: number
}

/** 工具帧来源：帧上的 `view` 说该用哪个渲染器，`metadata` 是给人看的那份结果。 */
export interface FrameArtifactSource {
  kind: 'frame'
  toolCallId: string
  view: string
  metadata: unknown
}

export type ArtifactSource = FileArtifactSource | FrameArtifactSource

export interface Artifact {
  /** `file:<path>` 或 `frame:<toolCallId>`。URL 上的 `artifact` 查询参数就是它。 */
  id: string
  type: string
  title: string
  source: ArtifactSource
}

/** 渲染器组件收到的东西。选中态与 Composer 引用是后面 PR 的事，这里先留位子。 */
export interface ArtifactRendererProps {
  conversationId: string
  artifact: Artifact
  selection?: unknown
  composerBridge?: unknown
}

/** 一条登记：什么样的来源归我画，标题怎么起，打开面板时要不要默认选中。 */
export interface ArtifactEntry {
  type: string
  match: { path: string } | { view: string }
  title: (source: ArtifactSource) => string
  component: ComponentType<ArtifactRendererProps>
  autoOpen: boolean
}

/** 合成产物列表时喂进来的工作区文件（`GET .../workspace/files` 的一行）。 */
export interface WorkbenchFile {
  path: string
  version: number
}

/** 合成产物列表时喂进来的工具帧（transcript 里已完成、带 `view` 的那些）。 */
export interface WorkbenchFrame {
  toolCallId: string
  view: string
  metadata?: unknown
}

export const fileArtifactId = (path: string) => `file:${path}`

export const frameArtifactId = (toolCallId: string) => `frame:${toolCallId}`
