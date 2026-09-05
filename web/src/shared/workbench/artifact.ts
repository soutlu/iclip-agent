/** 文件与工具帧共用产物合同（ADR-0009 决策 1）；具体渲染器由 app 注册，shared 宿主仅分派。 */

import type { ComponentType } from 'react'

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

export type ArtifactSource = FileArtifactSource | FrameArtifactSource

export interface Artifact {
  /** ID 为 file:<path> 或 frame:<toolCallId>，同时用作 artifact 查询参数。 */
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
  /** 文件按路径；工具帧按结果渲染器 view，或按服务端 display 的 kind。 */
  match: { path: string } | { view: string } | { displayKind: string }
  title: (source: ArtifactSource) => string
  component: ComponentType<ArtifactRendererProps>
  autoOpen: boolean
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
