import { useQuery } from '@tanstack/react-query'
import { type RefObject, useEffect, useRef, useState } from 'react'
import { ApiError } from '@/shared/api/client'
import { DialogBody, DialogHeader, DialogRoot, DialogSurface } from '@/shared/ui/dialog'
import { Input } from '@/shared/ui/field'
import { conversationsQueryKeys, searchConversations } from '../conversations.api'

type ConversationSearchDialogProps = {
  onOpenChange: (open: boolean) => void
  open: boolean
}

/** 搜索由后端执行，覆盖全部历史对话。 */
export function ConversationSearchDialog({ onOpenChange, open }: ConversationSearchDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null)

  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogSurface
        aria-label="搜索对话"
        // 打开弹窗时将焦点交给搜索框。
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          inputRef.current?.focus()
        }}
      >
        <DialogHeader
          className="h-(--layout-dialog-header-height) items-center border-b-0 px-6 py-0"
          closeLabel="关闭"
          title="搜索对话"
        />
        {/* 关闭时卸载，重置下次输入并停止订阅搜索。 */}
        {open ? <SearchPanel inputRef={inputRef} /> : null}
      </DialogSurface>
    </DialogRoot>
  )
}

function SearchPanel({ inputRef }: { inputRef: RefObject<HTMLInputElement | null> }) {
  const [keyword, setKeyword] = useState('')
  const [submitted, setSubmitted] = useState('')

  useEffect(() => {
    // 输入停止 250ms 后发起搜索。
    const timer = setTimeout(() => setSubmitted(keyword.trim()), 250)
    return () => clearTimeout(timer)
  }, [keyword])

  const results = useQuery({
    enabled: submitted.length > 0,
    queryFn: () => searchConversations(submitted),
    queryKey: conversationsQueryKeys.search(submitted),
  })

  return (
    <>
      <div className="shrink-0 px-6 pb-3">
        <Input
          aria-label="搜索对话"
          leadingIcon="search"
          onChange={(event) => setKeyword(event.target.value)}
          placeholder="搜索对话标题"
          ref={inputRef}
          value={keyword}
        />
      </div>
      <DialogBody className="flex min-h-30 flex-col gap-0.5 pt-0">
        <SearchResults keyword={submitted} query={results} />
      </DialogBody>
    </>
  )
}

type SearchResultsProps = {
  keyword: string
  query: ReturnType<typeof useQuery<Awaited<ReturnType<typeof searchConversations>>>>
}

function SearchResults({ keyword, query }: SearchResultsProps) {
  if (!keyword) return <Hint>输入关键词搜索你的对话</Hint>
  if (query.isPending) return <Hint>搜索中…</Hint>
  if (query.isError) {
    return <Hint>{query.error instanceof ApiError ? query.error.message : '搜索对话失败'}</Hint>
  }
  if (query.data.length === 0) return <Hint>没有匹配的对话</Hint>

  return (
    <ul aria-label="搜索结果" className="flex flex-col gap-0.5">
      {query.data.map((conversation) => (
        <li
          key={conversation.id}
          className="truncate rounded-sm px-2 py-2 text-body text-on-surface"
        >
          {conversation.title}
        </li>
      ))}
    </ul>
  )
}

function Hint({ children }: { children: string }) {
  return <p className="px-2 py-2 text-body-sm text-on-surface-variant">{children}</p>
}
