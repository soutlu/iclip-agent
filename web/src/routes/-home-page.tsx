import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { CollectionFormDialog, CollectionPicker, useCollections } from '@/features/collections'
import {
  conversationsQueryKeys,
  useConversationAgents,
  useStartConversation,
} from '@/features/conversations'
import { HomeRoute } from '@/features/home'
import { useUser } from '@/shared/auth'
import { Icon } from '@/shared/icons'
import type { ComposerSubmission } from '@/shared/ui/composer'
import { MenuItem, MenuRoot, MenuSurface, MenuTrigger } from '@/shared/ui/menu'
import { toast } from '@/shared/ui/toast'
import { useLoginPrompt } from './-login-prompt'

/** 路由组合首页输入、真实合集与对话创建；两端 feature 不互相依赖。 */
export function HomePage() {
  const { data: user } = useUser()
  const requireLogin = useLoginPrompt()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [chosenAgentId, setChosenAgentId] = useState<string | null>(null)
  const [chosenCollection, setChosenCollection] = useState<{
    ownerUserId: string | null
    id: string | null
  } | null>(null)
  const [newCollectionName, setNewCollectionName] = useState<string | null>(null)
  const canRun = user?.permissions.includes('agent:run') ?? false
  const canReadCollections = user?.permissions.includes('collections:read') ?? false
  const canWriteCollections = user?.permissions.includes('collections:write') ?? false
  const agents = useConversationAgents(canRun)
  const collectionsQuery = useCollections(canReadCollections)
  const collections = collectionsQuery.data ?? []
  const chosenCollectionId =
    chosenCollection && chosenCollection.ownerUserId === user?.id ? chosenCollection.id : null
  const chooseCollection = (id: string | null) =>
    setChosenCollection({ ownerUserId: user?.id ?? null, id })
  // 已删除的合集回到无关联；读取失败时保留缓存里的当前选择。
  const collectionId = collections.some((item) => item.id === chosenCollectionId)
    ? chosenCollectionId
    : null
  const agentId = chosenAgentId ?? agents.data?.default ?? null
  const chosenAgent = agents.data?.items.find((item) => item.id === agentId) ?? null
  const validAgent = chosenAgent !== null
  const start = useStartConversation(user?.id ?? null, (conversationId) => {
    void navigate({ params: { conversationId }, to: '/c/$conversationId' })
  })
  const send = async ({ parts }: ComposerSubmission): Promise<boolean> => {
    if (!user) {
      requireLogin()
      return false
    }
    if (!canRun) {
      toast.error('你没有发起创作的权限')
      return false
    }
    if (!validAgent || agentId === null || agents.isError) {
      toast.error(agents.error?.message ?? '请先选择可用的 Agent')
      return false
    }
    try {
      await start.mutateAsync({ agentId, collectionId, parts })
      return true
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '发送失败，请重试')
      return false
    }
  }
  const agentLabel = !user
    ? '登录后选择 Agent'
    : !canRun
      ? '无创作权限'
      : agents.isPending
        ? '正在加载 Agent…'
        : agents.isError
          ? 'Agent 加载失败'
          : chosenAgent
            ? chosenAgent.name
            : agentId
              ? '所选 Agent 已不可用'
              : '暂无可用 Agent'

  return (
    <>
      <HomeRoute
        agentPicker={
          <MenuRoot>
            <MenuTrigger
              className="inline-flex h-(--control-height-md) max-w-48 ui-state items-center gap-1 rounded-full px-2 text-body font-medium text-on-surface ui-focus disabled:text-disabled-text"
              disabled={!canRun || agents.isPending || start.isPending}
            >
              <span className="truncate">{agentLabel}</span>
              <Icon
                className="shrink-0 text-on-surface-variant"
                decorative
                name="expand"
                size="sm"
              />
            </MenuTrigger>
            <MenuSurface align="end">
              {agents.isError ? (
                <>
                  <p className="max-w-64 px-3 py-2 text-body-sm text-error" role="alert">
                    {agents.error.message}
                  </p>
                  <MenuItem onSelect={() => void agents.refetch()}>重新加载 Agent</MenuItem>
                </>
              ) : agents.data?.items.length ? (
                agents.data.items.map((item) => (
                  <MenuItem key={item.id} onSelect={() => setChosenAgentId(item.id)}>
                    {item.name}
                  </MenuItem>
                ))
              ) : (
                <p className="px-3 py-2 text-body-sm text-on-surface-variant" role="status">
                  暂无可用 Agent
                </p>
              )}
            </MenuSurface>
          </MenuRoot>
        }
        attachmentsEnabled={user?.permissions.includes('uploads:write') ?? false}
        collectionPicker={
          <CollectionPicker
            disabled={!canReadCollections || start.isPending}
            error={collectionsQuery.isError ? collectionsQuery.error.message : null}
            loading={canReadCollections && collectionsQuery.isPending}
            onChange={chooseCollection}
            onCreate={
              canWriteCollections && collectionsQuery.data ? setNewCollectionName : undefined
            }
            onRetry={() => void collectionsQuery.refetch()}
            options={collections}
            value={collectionId}
          />
        }
        onSend={send}
        preserveForLogin={!user}
        sending={start.isPending}
      />
      <CollectionFormDialog
        initialName={newCollectionName ?? ''}
        onOpenChange={(open) => {
          if (!open) setNewCollectionName(null)
        }}
        onSaved={(collection) => {
          chooseCollection(collection.id)
          // 侧栏的合集列表来自对话拓扑，新建后让它重拉。
          void queryClient.invalidateQueries({ queryKey: conversationsQueryKeys.sidebar() })
        }}
        open={newCollectionName !== null}
      />
    </>
  )
}
