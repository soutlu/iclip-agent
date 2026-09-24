/** 资料库页：页头与搜索、吸顶筛选条、瀑布流与翻页。筛选范围由路由存在查询参数里。 */

import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react'
import { errorMessageOf } from '@/shared/api/client'
import { Input } from '@/shared/ui/field'
import { ListEmpty, ListError, LoadMoreFooter } from '@/shared/ui/list-state'
import {
  isDefaultScope,
  useLibraryAuthorSource,
  useLibraryVideos,
  type LibraryScope,
} from '../library.api'
import { LibraryFilters } from './library-filters'
import { LibraryGrid, LibraryGridSkeleton } from './library-grid'

/** 停止输入这么久才按关键词重查。 */
const SEARCH_DEBOUNCE_MS = 300

type LibraryRouteProps = {
  scope: LibraryScope
  onScopeChange: (next: LibraryScope) => void
  myUserName: string | null
}

export function LibraryRoute({ scope, onScopeChange, myUserName }: LibraryRouteProps) {
  const mainRef = useRef<HTMLElement>(null)
  const getScrollElement = useCallback(() => mainRef.current, [])
  const videos = useLibraryVideos(scope)
  const authors = useLibraryAuthorSource()
  const loaded = videos.data?.pages.flatMap((page) => page.items) ?? []
  const total = videos.data?.pages[0]?.total ?? undefined

  const filtered = !isDefaultScope(scope)
  const counter = total === undefined ? undefined : filtered ? `找到 ${total} 条` : `共 ${total} 条`

  return (
    <main
      aria-label="资料库"
      className="flex min-h-0 flex-1 flex-col overflow-y-auto"
      ref={mainRef}
    >
      {/* 页头预留侧栏展开按钮的覆盖空间。 */}
      <div className="mx-auto flex w-full max-w-400 flex-col px-4 pt-12 pb-10 sm:px-8 sm:pt-14">
        <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4 pb-5">
          <div>
            <h1 className="text-headline font-semibold text-on-surface">资料库</h1>
            <p className="mt-2 text-body text-on-surface-variant">
              团队出过的每一条片，连同生成它的脚本。挑一条，直接拿来再创作。
            </p>
          </div>
          <SearchBox onSearch={(q) => onScopeChange({ ...scope, q })} value={scope.q} />
        </header>

        {/* 页内吸顶只需压住卡片；应用壳的侧栏抽屉在更高一层。 */}
        <div className="layer-content sticky top-0 -mx-1 bg-background px-1 py-3">
          <LibraryFilters
            authors={authors}
            myUserName={myUserName}
            onChange={onScopeChange}
            scope={scope}
            trailing={counter}
          />
        </div>

        <div className="pt-3">
          {videos.isPending ? (
            <LibraryGridSkeleton label="正在读取资料库" />
          ) : videos.isError && !videos.isFetchNextPageError ? (
            <ListError
              message={errorMessageOf(videos.error, '读取资料库失败')}
              onRetry={() => void videos.refetch()}
            />
          ) : loaded.length === 0 ? (
            <ListEmpty>
              {filtered ? '没有找到匹配的片子，换个关键词或清除筛选再看看' : '还没有成功出过的片'}
            </ListEmpty>
          ) : (
            <LibraryGrid
              getScrollElement={getScrollElement}
              onAuthor={(userName) => onScopeChange({ ...scope, userName })}
              videos={loaded}
            />
          )}

          {/* 翻页失败只落在页脚，已读取的卡片照常显示。 */}
          {videos.hasNextPage ? (
            videos.isFetchNextPageError && !videos.isFetchingNextPage ? (
              <ListError
                message={errorMessageOf(videos.error, '读取资料库失败')}
                onRetry={() => void videos.fetchNextPage()}
              />
            ) : (
              <LoadMoreFooter
                isFetching={videos.isFetchingNextPage}
                label="加载更多"
                onMore={() => void videos.fetchNextPage()}
                shown={loaded.length}
                total={total}
              />
            )
          ) : null}
        </div>
      </div>
    </main>
  )
}

/** 搜索框：输入即时显示，停顿后才改筛选；外部把关键词清掉时跟着清。 */
function SearchBox({ value, onSearch }: { value: string; onSearch: (q: string) => void }) {
  const [draft, setDraft] = useState(value)
  const [applied, setApplied] = useState(value)
  if (value !== applied) {
    setApplied(value)
    setDraft(value)
  }

  // 父组件每次渲染都会给新的 onSearch，放进依赖会让计时反复重来。
  const search = useEffectEvent((q: string) => onSearch(q))
  useEffect(() => {
    if (draft.trim() === applied.trim()) return
    const timer = setTimeout(() => search(draft.trim()), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [draft, applied])

  return (
    <div className="w-full sm:w-100">
      <Input
        aria-label="搜索脚本"
        leadingIcon="search"
        onChange={(event) => setDraft(event.target.value)}
        placeholder="搜场景、动作、镜头语言…"
        value={draft}
        wrapperClassName="h-(--control-height-xl) rounded-full"
      />
    </div>
  )
}
