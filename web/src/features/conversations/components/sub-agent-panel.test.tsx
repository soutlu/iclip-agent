import { screen } from '@testing-library/react'
import { http } from 'msw'
import { describe, expect, it } from 'vitest'
import { server } from '@/testing/mocks/server'
import {
  MOCK_CHILD_AGENT,
  MOCK_CHILD_REPLY,
  MOCK_CHILD_TASK,
  MOCK_HISTORY_CHILD,
  MOCK_HISTORY_DELEGATE_CALL,
} from '@/testing/mocks/transcript'
import { renderWithProviders } from '@/testing/render'
import type { Artifact } from '@/shared/workbench/artifact'
import { SubAgentPanel } from './sub-agent-panel'

const artifactFor = (childId: string): Artifact => ({
  id: `frame:${MOCK_HISTORY_DELEGATE_CALL}`,
  source: {
    agentRefs: [{ agentId: childId }],
    display: { agent_name: MOCK_CHILD_AGENT, kind: 'agent_call', prompt: MOCK_CHILD_TASK },
    kind: 'frame',
    metadata: undefined,
    toolCallId: MOCK_HISTORY_DELEGATE_CALL,
    view: 'generic',
  },
  title: `派活 · ${MOCK_CHILD_AGENT}`,
  type: 'sub-agent',
})

describe('SubAgentPanel', () => {
  it('按子代理 id 拉它那条流：任务文本是开场气泡，回复在下面，顶部是名字与状态', async () => {
    let asked = ''
    server.use(
      http.get('*/api/conversations/c1/transcript', ({ request }) => {
        asked = new URL(request.url).searchParams.get('agent_id') ?? ''
        return undefined
      }),
    )
    await renderWithProviders(
      <SubAgentPanel artifact={artifactFor(MOCK_HISTORY_CHILD)} conversationId="c1" />,
    )

    expect(await screen.findByText(MOCK_CHILD_TASK)).toBeVisible()
    expect(await screen.findByText(/S3-1 特写/)).toBeVisible()
    expect(screen.getByText(MOCK_CHILD_AGENT)).toBeVisible()
    expect(screen.getByText('完成')).toBeVisible()
    expect(asked).toBe(MOCK_HISTORY_CHILD)
    expect(MOCK_CHILD_REPLY).toContain('S3-1')
  })

  it('子代理不属于这段对话（404）：说明读不到，给重试钮', async () => {
    await renderWithProviders(
      <SubAgentPanel artifact={artifactFor('not-a-run')} conversationId="c1" />,
    )

    expect(await screen.findByText('无法加载这个子代理的对话')).toBeVisible()
    expect(screen.getByRole('button', { name: '重新加载' })).toBeVisible()
  })
})
