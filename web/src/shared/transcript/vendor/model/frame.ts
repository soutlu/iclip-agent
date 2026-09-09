import type { AgentId, FrameId, InteractionId, TaskId, TodoId } from './ids';

export type { InteractionKind, InteractionState } from './interaction';

export type FrameRef = {
  readonly target: 'frame';
  readonly frameId: FrameId;
};

/** 本仓扩展：用户消息的原样 part 列表，与发消息接口的 content 同形。 */
export type PromptContentPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly source: { readonly kind: 'url'; readonly url: string } }
  | { readonly type: 'video'; readonly source: { readonly kind: 'url'; readonly url: string } };

interface TextFrameBase {
  readonly kind: 'text';
  readonly frameId: FrameId;
  readonly text: string;
  readonly taskId?: TaskId;
  readonly promptIds?: readonly string[];
}

export interface AssistantTextFrame extends TextFrameBase {
  readonly role: 'assistant';
}

/** 用户块（运行中插进来的那条消息）必带 part 列表；`text` 是其中文字 part 相接的那份。 */
export interface UserTextFrame extends TextFrameBase {
  readonly role: 'user';
  readonly content: readonly PromptContentPart[];
}

export type TextFrame = AssistantTextFrame | UserTextFrame;

export interface ThinkingFrame {
  readonly kind: 'thinking';
  readonly frameId: FrameId;
  readonly text: string;
}

export type ToolFrameState = 'running' | 'done' | 'error';

export interface ToolFrameProgress {
  readonly kind: 'stdout' | 'stderr' | 'progress' | 'status' | 'custom';
  readonly text?: string;
  readonly percent?: number;
  readonly customKind?: string;
  readonly customData?: unknown;
}

export interface AgentRef {
  readonly agentId: AgentId;
  readonly role?: 'child' | 'member';
}

export interface ToolCallFrame {
  readonly kind: 'tool';
  readonly frameId: FrameId;
  readonly toolCallId: string;
  readonly name: string;
  readonly view?: string;
  readonly state: ToolFrameState;
  readonly input?: unknown;
  readonly output?: unknown;
  readonly display?: unknown;
  /** 本仓扩展：给人看的那份结果（见 README「做过的改写」）。 */
  readonly metadata?: unknown;
  readonly error?: string;
  readonly inputText?: string;
  readonly progress?: ToolFrameProgress;
  readonly taskId?: TaskId;
  readonly approvalId?: InteractionId;
  readonly todoId?: TodoId;
  readonly agentRefs?: readonly AgentRef[];
}

export interface NoticeFrame {
  readonly kind: 'notice';
  readonly frameId: FrameId;
  readonly level: 'error' | 'warning' | 'info';
  readonly source?: string;
  readonly message: string;
  readonly detail?: unknown;
}

export type TranscriptFrame =
  | TextFrame
  | ThinkingFrame
  | ToolCallFrame
  | NoticeFrame;
