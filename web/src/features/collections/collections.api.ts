import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import { apiFetch } from '@/shared/api/client'
import { zCollectionEnvelope, zCollectionsPageOut } from '@/shared/api/generated/zod.gen'

// 删除返回 204，没有正文可校验
const noContentSchema = z.unknown()

const collectionEnvelopeSchema = zCollectionEnvelope.transform((payload) => payload.collection)
const collectionsPageSchema = zCollectionsPageOut.transform((payload) => payload.items)

// 合集是自己建的，一屏之内的量；后端上限 100，这里要满就是要全部
const LIST_LIMIT = 100

const collectionsQueryKeys = {
  all: ['collections'] as const,
  list: () => ['collections', 'list'] as const,
}

/** 我的合集，最近改动的排前面。别人的合集看不见，所以不带任何过滤参数。 */
export const useCollections = (enabled: boolean) =>
  useQuery({
    enabled,
    queryFn: () =>
      apiFetch(`/collections?limit=${LIST_LIMIT}`, collectionsPageSchema, {
        cache: 'no-store',
        fallbackErrorMessage: '读取合集失败',
      }),
    queryKey: collectionsQueryKeys.list(),
  })

/**
 * 新建或改名：给了 collectionId 就是改名，没给就是新建。
 *
 * @param onSaved - 落库之后调用，由调用方顺手刷掉侧栏拓扑那份缓存。
 * @returns TanStack mutation。
 */
export const useSaveCollection = (onSaved: () => void) => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ collectionId, name }: { collectionId?: string | undefined; name: string }) =>
      apiFetch(
        collectionId ? `/collections/${collectionId}` : '/collections',
        collectionEnvelopeSchema,
        {
          body: { name },
          fallbackErrorMessage: collectionId ? '重命名合集失败' : '新建合集失败',
          method: collectionId ? 'PATCH' : 'POST',
        },
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: collectionsQueryKeys.all })
      onSaved()
    },
  })
}

/** 删合集。里面的对话不会跟着没，只是不再属于任何合集。 */
export const useDeleteCollection = (onSaved: () => void) => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (collectionId: string) =>
      apiFetch(`/collections/${collectionId}`, noContentSchema, {
        fallbackErrorMessage: '删除合集失败',
        method: 'DELETE',
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: collectionsQueryKeys.all })
      onSaved()
    },
  })
}
