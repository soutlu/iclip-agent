/** 文件、工具帧与整个工作区共用产物合同（ADR-0009 决策 1，ADR-0015 加第三种来源）；具体渲染器由 app 注册，shared 宿主仅分派。 */

import type { ComponentType } from 'react'
import type { IconName } from '@/shared/icons'

/** 文件版本变化时渲染器重新读取内容。 */
export interface FileArtifactSource {
  kind: 'file'
  path: string
  version: number
}

/** 工具帧上派出的子代理引用；面板按第一个 agentId 读它那条流。 */
export interface FrameAgentRef {
  agentId: string
}

/** 工具帧由 view 或 display.kind 选择渲染器，metadata 提供展示结果。 */
export interface FrameArtifactSource {
  kind: 'frame'
  toolCallId: string
  view: string
  metadata: unknown
  display?: unknown
  agentRefs?: readonly FrameAgentRef[]
}

/** 整个工作区当一件产物；渲染器自己读文件列表，来源上只带个数给选择页写行尾。 */
export interface WorkspaceArtifactSource {
  kind: 'workspace'
  fileCount: number
}

export type ArtifactSource = FileArtifactSource | FrameArtifactSource | WorkspaceArtifactSource

export interface Artifact {
  /** ID 为 file:<path>、frame:<toolCallId> 或 workspace，同时用作 artifact 查询参数。 */
  id: string
  type: string
  title: string
  source: ArtifactSource
}

export interface ArtifactRendererProps {
  conversationId: string
  artifact: Artifact
  selection?: unknown
  composerBridge?: unknown
}

export interface ArtifactEntry {
  type: string
  /** 文件按路径；工具帧按结果渲染器 view，或按服务端 display 的 kind；工作区只要有文件就命中。 */
  match: { path: string } | { view: string } | { displayKind: string } | { workspace: true }
  /** 这一类产物的名字，菜单里还没有产物的常驻行也用它。 */
  label: string
  /** 某一件产物的标题，可以比 label 更具体。 */
  title: (source: ArtifactSource) => string
  /** 菜单行尾的一句补充，同名的几件产物靠它分开（比如派活卡的任务摘要）。 */
  detail?: (source: ArtifactSource) => string | undefined
  /** 折叠态菜单里这一类产物的图标。 */
  icon: IconName
  component: ComponentType<ArtifactRendererProps>
  autoOpen: boolean
  /** 按路径或工作区命中的类型是常驻项：还没有产物时菜单照样列出它，用这一句解释为什么灰着。 */
  empty?: string
}

export interface WorkbenchFile {
  path: string
  version: number
}

export interface WorkbenchFrame {
  toolCallId: string
  view: string
  metadata?: unknown
  display?: unknown
  agentRefs?: readonly FrameAgentRef[]
}

export const fileArtifactId = (path: string) => `file:${path}`

export const frameArtifactId = (toolCallId: string) => `frame:${toolCallId}`

export const WORKSPACE_ARTIFACT_ID = 'workspace'
