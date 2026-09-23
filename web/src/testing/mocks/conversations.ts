import type { z } from 'zod'
import type { zCollectionOut, zConversationOut } from '@/shared/api/generated/zod.gen'
import { mockAuthUser } from './auth-user'
import { mockCreatedAt } from './paging'

// 内存对话与合集遵循 ConversationOut / CollectionOut；单独成模块，transcript mock 才能按 id 查属主而不成环。

export type MockConversation = z.output<typeof zConversationOut>

/** 删除只写 deletedAt（合同 §6 墓碑）；墓碑只有审计列表列得出来。 */
export const mockConversations: MockConversation[] = []

/** 还活着的那一段；墓碑对改名、换归属、再删、发消息一律按不存在答复。 */
export const liveMockConversation = (conversationId: string) =>
  mockConversations.find((item) => item.id === conversationId && item.deletedAt === null)

export const addMockConversation = (
  title: string,
  createdAt = mockCreatedAt(),
  ownerUserId = mockAuthUser.id,
) => {
  const conversation: MockConversation = {
    activity: {
      busy: false,
      lastTurnReason: null,
      pendingInteraction: 'none',
      videoGeneration: 'none',
    },
    agentId: 'storyboard',
    collectionId: null,
    completedAt: null,
    createdAt,
    deletedAt: null,
    forkTurn: null,
    forkedFrom: null,
    id: crypto.randomUUID(),
    lastRunId: null,
    ownerUserId,
    taskId: null,
    title,
    updatedAt: createdAt,
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

type MockCollection = z.output<typeof zCollectionOut>

export const mockCollections: MockCollection[] = []

export const addMockCollection = (name: string) => {
  const now = mockCreatedAt()
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
