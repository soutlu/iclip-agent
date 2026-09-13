import { mockAuthUser } from './auth-user'

// 内存对话与合集遵循 ConversationOut / CollectionOut；单独成模块，transcript mock 才能按 id 查属主而不成环。

export type MockConversation = {
  activity: {
    busy: boolean
    lastTurnReason: 'completed' | 'failed' | 'aborted' | null
    pendingInteraction: 'none' | 'approval' | 'question'
  }
  agentId: string
  collectionId: string | null
  createdAt: string
  id: string
  lastRunId: string | null
  ownerUserId: string
  taskId: string | null
  title: string
  updatedAt: string
}

export const mockConversations: MockConversation[] = []

export const addMockConversation = (
  title: string,
  updatedAt = new Date().toISOString(),
  ownerUserId = mockAuthUser.id,
) => {
  const conversation: MockConversation = {
    activity: { busy: false, lastTurnReason: null, pendingInteraction: 'none' },
    agentId: 'storyboard',
    collectionId: null,
    createdAt: updatedAt,
    id: crypto.randomUUID(),
    lastRunId: null,
    ownerUserId,
    taskId: null,
    title,
    updatedAt,
  }
  mockConversations.push(conversation)
  return conversation
}

/** 缺省属主是登录的测试用户；找不到那段对话时也按它算，历史用例不带对话行也能读 transcript。 */
export const mockConversationOwner = (conversationId: string): string =>
  mockConversations.find((item) => item.id === conversationId)?.ownerUserId ?? mockAuthUser.id

export const resetMockConversations = () => {
  mockConversations.length = 0
  mockCollections.length = 0
}

type MockCollection = {
  createdAt: string
  id: string
  name: string
  ownerUserId: string
  updatedAt: string
}

export const mockCollections: MockCollection[] = []

export const addMockCollection = (name: string) => {
  const now = new Date().toISOString()
  const collection: MockCollection = {
    createdAt: now,
    id: crypto.randomUUID(),
    name,
    ownerUserId: mockAuthUser.id,
    updatedAt: now,
  }
  mockCollections.push(collection)
  return collection
}
