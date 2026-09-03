import { describe, expect, it } from 'vitest';

import { filterOpsForGrade, isAppendOnly, redactSnapshotForGrade } from '../granularity/filterOps';
import { detachGrades, gradeFor, needsResetOnTransition } from '../granularity/grade';
import { paginateTurns } from '../pagination/paginate';
import { ViewRegistry } from '../view/registry';
import {
  transcriptOperationSchema,
  transcriptQuerySchema,
  transcriptResponseSchema,
  transcriptGradeSpecSchema,
} from '../contract/schema';
import type { TranscriptItem } from '../model/item';
import type { AgentTranscriptSnapshot, TranscriptOperation } from '../ops/operation';

const idLabel = (i: TranscriptItem): string =>
  i.kind === 'turn' ? i.turnId : i.kind === 'marker' ? i.markerId : i.refId;

const turnOp = (n: number): TranscriptOperation => ({
  op: 'turn.upsert',
  turn: {
    kind: 'turn',
    turnId: `t${n}`,
    ordinal: n,
    state: 'running',
    origin: { kind: 'user' },
    content: [],
  },
});

const stepOp: TranscriptOperation = {
  op: 'step.upsert',
  turnId: 't1',
  step: { kind: 'step', stepId: 't1.1', turnId: 't1', ordinal: 1, state: 'running' },
};

const frameOp: TranscriptOperation = {
  op: 'frame.upsert',
  turnId: 't1',
  stepId: 't1.1',
  frame: { kind: 'text', frameId: 't1.1.f1', role: 'assistant', text: 'full' },
};

const appendOp: TranscriptOperation = {
  op: 'append',
  target: { type: 'frame', turnId: 't1', stepId: 't1.1', frameId: 't1.1.f1' },
  offset: 0,
  text: 'chunk',
};

const promptOp: TranscriptOperation = {
  op: 'prompt.upsert',
  prompt: { promptId: 'p1', status: 'queued', createdAt: '2026-07-22T00:00:00.000Z' },
};

describe('granularity', () => {
  const ops: TranscriptOperation[] = [
    turnOp(1),
    stepOp,
    frameOp,
    appendOp,
    promptOp,
    { op: 'meta.merge', meta: { activity: 'turn' } },
  ];

  it('off admits nothing', () => {
    expect(filterOpsForGrade('off', ops)).toEqual([]);
  });

  it('turn admits headers and global state only', () => {
    expect(filterOpsForGrade('turn', ops).map((op) => op.op)).toEqual([
      'turn.upsert',
      'prompt.upsert',
      'meta.merge',
    ]);
  });

  it('block admits step/frame upserts but no appends', () => {
    expect(filterOpsForGrade('block', ops).map((op) => op.op)).toEqual([
      'turn.upsert',
      'step.upsert',
      'frame.upsert',
      'prompt.upsert',
      'meta.merge',
    ]);
  });

  it('delta admits everything', () => {
    expect(filterOpsForGrade('delta', ops)).toHaveLength(ops.length);
  });

  it('gradeFor resolves agent override over wildcard default', () => {
    const spec = { '*': 'turn', main: 'delta' } as const;
    expect(gradeFor(spec, 'main')).toBe('delta');
    expect(gradeFor(spec, 'sub-1')).toBe('turn');
    expect(gradeFor(undefined, 'main')).toBe('off');
  });

  it('upgrade needs reset, downgrade does not', () => {
    expect(needsResetOnTransition('turn', 'delta')).toBe(true);
    expect(needsResetOnTransition('delta', 'turn')).toBe(false);
  });

  it('detachGrades writes explicit off so a wildcard default cannot resurrect the agent', () => {
    expect(detachGrades({ '*': 'delta' }, ['main'])).toEqual({ '*': 'delta', main: 'off' });
    expect(detachGrades({ '*': 'delta', main: 'turn' }, ['main'])).toEqual({
      '*': 'delta',
      main: 'off',
    });
  });

  it('detachGrades deletes a listed wildcard entry', () => {
    expect(detachGrades({ '*': 'delta', main: 'turn' }, ['*'])).toEqual({ main: 'turn' });
  });

  it('detachGrades collapses an all-off spec to undefined', () => {
    expect(detachGrades({ main: 'delta' }, ['main'])).toBeUndefined();
    expect(detachGrades({ '*': 'delta', main: 'off' }, ['*'])).toBeUndefined();
    expect(detachGrades(undefined, ['main'])).toBeUndefined();
  });

  it('append-only batches are volatile-safe', () => {
    expect(isAppendOnly([appendOp])).toBe(true);
    expect(isAppendOnly([appendOp, frameOp])).toBe(false);
  });

  it('redactSnapshotForGrade strips step detail below block, keeps it at block+', () => {
    const snapshot: AgentTranscriptSnapshot = {
      items: [
        {
          kind: 'turn',
          turnId: 't1',
          ordinal: 1,
          state: 'completed',
          origin: { kind: 'user' },
          content: [{ type: 'text', text: 'hi' }],
          steps: [
            {
              kind: 'step',
              stepId: 't1.1',
              turnId: 't1',
              ordinal: 1,
              state: 'completed',
              frames: [{ kind: 'text', frameId: 't1.1.f1', role: 'assistant', text: 'body' }],
            },
          ],
        },
        { kind: 'marker', markerId: 'm1', marker: 'skill' },
      ],
      tasks: [],
      interactions: [
        {
          interactionId: 'appr-1',
          interactionKind: 'approval' as const,
          toolCallId: 'c1',
          state: 'pending' as const,
        },
      ],
      attachments: [
        { attachmentId: 'att_1', mediaType: 'image/png', source: { kind: 'url' as const, url: 'https://example.com/a.png' } },
      ],
      todos: [{ todoId: 'todo', items: [{ title: 'write tests', status: 'in_progress' as const }] }],
      prompts: [{ promptId: 'p1', status: 'running' as const, createdAt: '2026-07-22T00:00:00.000Z' }],
      meta: {},
    };
    const turnGrade = redactSnapshotForGrade('turn', snapshot);
    expect(turnGrade.interactions).toHaveLength(1);
    expect(turnGrade.attachments).toHaveLength(1);
    expect(turnGrade.todos).toHaveLength(1);
    expect(turnGrade.prompts).toHaveLength(1);
    const turn = turnGrade.items[0];
    expect(turn?.kind === 'turn' && turn.steps).toEqual([]);
    expect(turn?.kind === 'turn' && turn.content).toEqual([{ type: 'text', text: 'hi' }]);
    expect(turnGrade.items[1]?.kind).toBe('marker');
    expect(redactSnapshotForGrade('block', snapshot)).toBe(snapshot);
    expect(redactSnapshotForGrade('delta', snapshot)).toBe(snapshot);
  });
});

describe('paginateTurns', () => {
  const items: TranscriptItem[] = [
    { kind: 'marker', markerId: 'm0', marker: 'goal' },
    ...[1, 2, 3, 4, 5].flatMap((n): TranscriptItem[] => [
      {
        kind: 'turn',
        turnId: `t${n}`,
        ordinal: n,
        state: 'completed',
        origin: { kind: 'user' },
        content: [],
        steps: [],
      },
      { kind: 'marker', markerId: `m${n}`, marker: 'skill' },
    ]),
  ];

  it('default page is the newest N turns with trailing segment items', () => {
    const page = paginateTurns(items, { pageSize: 2 });
    expect(page.items.map(idLabel)).toEqual(['t4', 'm4', 't5', 'm5']);
    expect(page.hasMore).toBe(true);
  });

  it('before_turn pages toward older turns; head marker rides the oldest segment', () => {
    const page = paginateTurns(items, { beforeTurn: 't4', pageSize: 2 });
    expect(page.items.map(idLabel)).toEqual(['t2', 'm2', 't3', 'm3']);
    expect(page.hasMore).toBe(true);

    const oldest = paginateTurns(items, { beforeTurn: 't2', pageSize: 5 });
    expect(oldest.items[0]).toEqual({ kind: 'marker', markerId: 'm0', marker: 'goal' });
    expect(oldest.hasMore).toBe(false);
  });

  it('after_turn pages toward newer turns without the head unit', () => {
    const page = paginateTurns(items, { afterTurn: 't3', pageSize: 2 });
    expect(page.items.map(idLabel)).toEqual(['t4', 'm4', 't5', 'm5']);
    expect(page.hasMore).toBe(false);
  });

  it('keeps head non-turn items with the newest page when turns exactly fill it', () => {
    const page = paginateTurns(items, { pageSize: 5 });
    expect(page.items[0]).toEqual({ kind: 'marker', markerId: 'm0', marker: 'goal' });
    expect(page.items.map(idLabel)).toEqual(['m0', 't1', 'm1', 't2', 'm2', 't3', 'm3', 't4', 'm4', 't5', 'm5']);
    expect(page.hasMore).toBe(false);
  });

  it('returns a marker-only timeline as one page with nothing older', () => {
    const only = paginateTurns([{ kind: 'marker', markerId: 'm0', marker: 'goal' }], { pageSize: 3 });
    expect(only.items.map(idLabel)).toEqual(['m0']);
    expect(only.hasMore).toBe(false);
  });
});

describe('ViewRegistry', () => {
  it('dispatches on view ?? name, origin.kind and marker keys', () => {
    const registry = new ViewRegistry<string>({ fallbackTool: 'generic' });
    registry.registerTool('read', 'readRenderer');
    registry.registerTool('swarm', 'swarmRenderer');
    registry.registerInput('cron', 'cronInput');
    registry.registerMarker('goal', 'goalMarker');

    expect(
      registry.resolveTool({ kind: 'tool', frameId: 'f', toolCallId: 'c1', name: 'Read', state: 'done' }),
    ).toBe('readRenderer');
    expect(
      registry.resolveTool({ kind: 'tool', frameId: 'f', toolCallId: 'c2', name: 'AgentSwarm', view: 'swarm', state: 'running' }),
    ).toBe('swarmRenderer');
    expect(
      registry.resolveTool({ kind: 'tool', frameId: 'f', toolCallId: 'c3', name: 'Bash', state: 'running' }),
    ).toBe('generic');
    expect(registry.resolveInput({ kind: 'cron' })).toBe('cronInput');
    expect(registry.resolveInput({ kind: 'user' })).toBeUndefined();
    expect(registry.resolveMarker('goal')).toBe('goalMarker');
  });
});

describe('contract schemas', () => {
  it('roundtrips every op kind', () => {
    const ops: TranscriptOperation[] = [
      { op: 'reset', agentId: 'main', snapshot: { items: [], tasks: [], interactions: [], attachments: [], todos: [], prompts: [], meta: {}, hasMoreOlder: true } },
      turnOp(1),
      stepOp,
      frameOp,
      appendOp,
      { op: 'marker.upsert', item: { kind: 'marker', markerId: 'm1', marker: 'goal' } },
      { op: 'taskref.upsert', item: { kind: 'taskref', refId: 'r1', taskId: 'task1' } },
      { op: 'task.upsert', task: { taskId: 'task1', kind: 'shell', state: 'running', detached: false, outputTail: '' } },
      {
        op: 'interaction.upsert',
        interaction: { interactionId: 'appr-1', interactionKind: 'approval', toolCallId: 'c1', state: 'pending' },
      },
      {
        op: 'attachment.upsert',
        attachment: { attachmentId: 'att_1', mediaType: 'image/png', source: { kind: 'file', fileId: 'f1' } },
      },
      { op: 'todo.upsert', todo: { todoId: 'todo', items: [{ title: 'x', status: 'done' }] } },
      promptOp,
      { op: 'meta.merge', meta: { goal: { objective: 'x', status: 'active' } } },
      { op: 'items.remove', ids: ['t1'] },
    ];
    for (const op of ops) {
      expect(transcriptOperationSchema.parse(op)).toBeDefined();
    }
  });

  it('roundtrips ops carrying the extended wire detail', () => {
    const usage = { inputOther: 10, output: 5, inputCacheRead: 3, inputCacheCreation: 2 };
    const ops: TranscriptOperation[] = [
      {
        op: 'reset',
        agentId: 'main',
        snapshot: {
          items: [],
          tasks: [],
          interactions: [],
          attachments: [],
          todos: [],
          prompts: [
            {
              promptId: 'p1',
              status: 'completed',
              userMessageId: 'u1',
              content: [{ type: 'text', text: 'hi' }],
              createdAt: '2026-07-22T00:00:00.000Z',
              finishedAt: '2026-07-22T00:01:00.000Z',
              steeredAt: '2026-07-22T00:00:30.000Z',
            },
          ],
          meta: {
            agent: {
              model: 'k2',
              thinkingEffort: 'high',
              usage: { byModel: { k2: usage }, currentTurn: usage, total: usage },
              contextTokens: 1234,
              maxContextTokens: 128000,
              contextUsage: 0.01,
              permission: 'auto',
              phase: { kind: 'retrying', turnId: 1, step: 1, stepId: 't1.1', failedAttempt: 1, nextAttempt: 2, maxAttempts: 3, delayMs: 500, since: 1000 },
            },
          },
        },
      },
      {
        op: 'turn.upsert',
        turn: {
          kind: 'turn', turnId: 't1', ordinal: 1, state: 'failed', origin: { kind: 'user' },
          content: [{ type: 'text', text: 'go' }],
          usage: { inputTokens: 12, outputTokens: 5, cachedTokens: 3 },
          durationMs: 1500,
          error: 'boom',
        },
      },
      {
        op: 'step.upsert',
        turnId: 't1',
        step: {
          kind: 'step', stepId: 't1.1', turnId: 't1', ordinal: 1, state: 'interrupted',
          usage,
          finishReason: 'stop',
          timing: {
            llmFirstTokenLatencyMs: 120,
            llmStreamDurationMs: 900,
            llmRequestBuildMs: 5,
            llmServerFirstTokenMs: 110,
            llmServerDecodeMs: 700,
            llmClientConsumeMs: 950,
          },
          retry: { failedAttempt: 1, nextAttempt: 2, maxAttempts: 3, delayMs: 500, errorName: 'RateLimit', errorMessage: 'slow down', statusCode: 429 },
          endReason: 'aborted',
          endMessage: 'user pressed escape',
        },
      },
      {
        op: 'frame.upsert',
        turnId: 't1',
        stepId: 't1.1',
        frame: {
          kind: 'tool', frameId: 't1.1.c1', toolCallId: 'c1', name: 'Bash', state: 'running',
          inputText: '{"command":"ls',
          progress: { kind: 'progress', text: 'half', percent: 50, customKind: 'bar', customData: { x: 1 } },
        },
      },
      {
        op: 'task.upsert',
        task: {
          taskId: 'task1', kind: 'subagent', state: 'completed', detached: false, outputTail: '',
          resultSummary: 'scanned 12 files',
          error: 'partial failure',
          stateReason: 'waiting for input',
          usage,
        },
      },
      {
        op: 'meta.merge',
        meta: { agent: { model: 'k2', phase: { kind: 'ended', turnId: 1, reason: 'completed', durationMs: 1500, at: 2000 } } },
      },
    ];
    for (const op of ops) {
      expect(transcriptOperationSchema.parse(op)).toEqual(op);
    }
  });

  it('rejects mutually exclusive cursors and bad grades', () => {
    expect(() => transcriptGradeSpecSchema.parse({ '*': 'stream' })).toThrow();
    const ok = transcriptResponseSchema.safeParse({
      agent_id: 'main',
      items: [],
      has_more: false,
      tasks: [],
      interactions: [],
      attachments: [],
      todos: [],
      meta: {},
      agents: [{ agentId: 'main', type: 'main' }],
      pending_interactions: [],
    });
    expect(ok.success).toBe(true);
  });

  it('rejects path-hostile agent ids in the transcript query', () => {
    const base = { agent_id: 'main', before_turn: undefined, after_turn: undefined, page_size: undefined };
    expect(transcriptQuerySchema.safeParse({ ...base, agent_id: 'sub-1' }).success).toBe(true);
    expect(transcriptQuerySchema.safeParse({ ...base, agent_id: '01HF7YAT31J7SMRT1QXGJWKR8D' }).success).toBe(true);
    for (const hostile of ['../main', '..\\main', '..', 'a/b', 'a\\b', '.', 'a\0b', 'x'.repeat(200)]) {
      expect(transcriptQuerySchema.safeParse({ ...base, agent_id: hostile }).success).toBe(false);
    }
  });
});

