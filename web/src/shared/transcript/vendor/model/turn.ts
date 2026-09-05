import type { PromptContentPart, TranscriptFrame } from './frame';
import type { StepId, TaskId, TurnId } from './ids';

export type TurnOrigin =
  | { kind: 'user'; payload?: unknown }
  | { kind: 'cron'; taskId?: TaskId; payload?: unknown }
  | { kind: 'task'; taskId: TaskId; payload?: unknown }
  | { kind: 'hook'; payload?: unknown }
  | { kind: 'compaction'; payload?: unknown }
  | { kind: 'side'; payload?: unknown }
  | { kind: 'other'; payload?: unknown };

export type TurnState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export type StepState = 'running' | 'completed' | 'interrupted' | 'failed';

export interface TranscriptUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedTokens?: number;
  readonly cost?: number;
}

export interface StepUsage {
  readonly inputOther: number;
  readonly output: number;
  readonly inputCacheRead: number;
  readonly inputCacheCreation: number;
}

export interface StepTiming {
  readonly llmFirstTokenLatencyMs?: number;
  readonly llmStreamDurationMs?: number;
  readonly llmRequestBuildMs?: number;
  readonly llmServerFirstTokenMs?: number;
  readonly llmServerDecodeMs?: number;
  readonly llmClientConsumeMs?: number;
}

export interface StepRetry {
  readonly failedAttempt: number;
  readonly nextAttempt: number;
  readonly maxAttempts: number;
  readonly delayMs: number;
  readonly errorName: string;
  readonly errorMessage: string;
  readonly statusCode?: number;
}

export interface TranscriptTurn {
  readonly kind: 'turn';
  readonly turnId: TurnId;
  /** 发起这一轮的消息 id；乐观气泡按它认领。子代理的轮没有。 */
  readonly triggerPromptId?: string;
  readonly ordinal: number;
  readonly state: TurnState;
  readonly origin: TurnOrigin;
  /** 本仓扩展：开场那条用户消息的原样 part 列表。 */
  readonly content: readonly PromptContentPart[];
  readonly steps: TranscriptStep[];
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly usage?: TranscriptUsage;
  readonly durationMs?: number;
  readonly error?: string;
}

export interface TranscriptStep {
  readonly kind: 'step';
  readonly stepId: StepId;
  readonly turnId: TurnId;
  readonly ordinal: number;
  readonly state: StepState;
  readonly frames: TranscriptFrame[];
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly usage?: StepUsage;
  readonly finishReason?: string;
  readonly timing?: StepTiming;
  readonly retry?: StepRetry;
  readonly endReason?: string;
  readonly endMessage?: string;
}
