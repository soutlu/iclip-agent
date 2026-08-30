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

/**
 * 搜索对话弹窗：输入关键词，列出标题命中的对话，最近活动的排前面。
 *
 * 筛选由后端做（`GET /conversations?q=`），所以搜得到全部历史，而不只是列表接口
 * 一次给得下的那几十段。
 */
export function ConversationSearchDialog({ onOpenChange, open }: ConversationSearchDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null)

  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogSurface
        aria-label="搜索对话"
        // 弹层默认把焦点丢给关闭键；这里打开就是为了打字，焦点直接给搜索框
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
        {/* 关掉就卸载：下次打开是干净的空输入框，也不会在退场动画里还挂着一个搜索请求 */}
        {open ? <SearchPanel inputRef={inputRef} /> : null}
      </DialogSurface>
    </DialogRoot>
  )
}

function SearchPanel({ inputRef }: { inputRef: RefObject<HTMLInputElement | null> }) {
  const [keyword, setKeyword] = useState('')
  const [submitted, setSubmitted] = useState('')

  useEffect(() => {
    // 每敲一个字都打一次接口太吵：停手 250ms 才发
    const timer = setTimeout(() => setSubmitted(keyword.trim()), 250)
    return () => clearTimeout(timer)
  }, [keyword])

  const results = useQuery({
    enabled: submitted.length > 0,
    queryFn: () => searchConversations(submitted),
    queryKey: conversationsQueryKeys.search(submitted),
  })

  return (
    <DialogBody className="flex flex-col gap-3 pt-0">
      <Input
        aria-label="搜索对话"
        leadingIcon="search"
        onChange={(event) => setKeyword(event.target.value)}
        placeholder="搜索对话标题"
        ref={inputRef}
        value={keyword}
      />
      <div className="flex min-h-30 flex-col gap-0.5">
        <SearchResults keyword={submitted} query={results} />
      </div>
    </DialogBody>
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
        // 还没有对话页，命中只列出来看，点不开
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
