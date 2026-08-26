import type { ThreadMessage } from '@assistant-ui/react'
import { useQuery } from '@tanstack/react-query'
import { CircleCheck, FileText, LoaderCircle } from 'lucide-react'
import { useMemo, useState } from 'react'
import {
  listConversationWorkspaceFiles,
  readConversationWorkspaceFile,
} from '@/features/conversations'
import { cn } from '@/shared/lib/utils'

const PANEL_CLASS =
  'overflow-hidden rounded-lg border border-[var(--color-outline-variant)] bg-[var(--color-surface-container-lowest)]'

/**
 * 决定何时重拉文件列表：每有一个工具调用出了结果，或运行结束，就拉一次。
 *
 * 不认工具名——写文件的不只 `write_file` 那几件，镜头素材那组工具也会顺手往工作区写；
 * 列表接口只返回元信息，多拉几次很便宜。
 */
const workspaceRevision = (messages: readonly ThreadMessage[], isRunning: boolean) => {
  let completedToolCalls = 0

  for (const message of messages) {
    if (message.role !== 'assistant') continue

    for (const part of message.content) {
      if (part.type === 'tool-call' && part.result !== undefined) completedToolCalls += 1
    }
  }

  return `${completedToolCalls}:${isRunning ? 'running' : 'idle'}`
}

/** 调试页的「Workspace 文件」面板：列出 agent 在这段对话里写下的文件，选中一个看全文。 */
export default function DebugWorkspaceFiles({
  conversationId,
  isRunning,
  messages,
}: {
  conversationId: string
  isRunning: boolean
  messages: readonly ThreadMessage[]
}) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const revision = useMemo(() => workspaceRevision(messages, isRunning), [isRunning, messages])
  const filesQuery = useQuery({
    queryFn: ({ signal }) => listConversationWorkspaceFiles(conversationId, { signal }),
    queryKey: ['conversation-workspace-files', conversationId, revision],
  })
  const files = filesQuery.data
  const selectedFile = files?.find((file) => file.path === selectedPath) ?? files?.[0]
  // 正文按版本号缓存：列表刷新后版本没变，就不重读。
  const contentQuery = useQuery({
    enabled: selectedFile !== undefined,
    queryFn: ({ signal }) =>
      readConversationWorkspaceFile(conversationId, selectedFile?.path ?? '', { signal }),
    queryKey: [
      'conversation-workspace-file',
      conversationId,
      selectedFile?.path,
      selectedFile?.version,
    ],
  })

  return (
    <aside
      aria-label="Workspace 文件"
      className={cn(PANEL_CLASS, 'flex h-full min-h-0 min-w-0 flex-col')}
    >
      <div className="flex items-center justify-between border-b border-[var(--color-outline-variant)] px-4 py-3">
        <h2
          className="flex items-center gap-2 text-body font-semibold text-[var(--color-on-surface)]"
          id="debug-workspace-title"
        >
          <FileText aria-hidden="true" size={16} />
          Workspace 文件
        </h2>
        {files ? (
          <div className="flex items-center gap-3 text-label text-[var(--color-on-surface-variant)]">
            <span className="flex items-center gap-1 text-[var(--color-secondary)]">
              {filesQuery.isFetching ? (
                <LoaderCircle aria-hidden="true" className="animate-spin" size={14} />
              ) : (
                <CircleCheck aria-hidden="true" size={14} />
              )}
              {filesQuery.isFetching ? '刷新中' : '已同步'}
            </span>
            <span>{files.length} 个文件</span>
          </div>
        ) : null}
      </div>

      {filesQuery.isPending ? (
        <p className="px-4 py-5 text-body-sm text-[var(--color-on-surface-variant)]" role="status">
          正在读取 Workspace…
        </p>
      ) : filesQuery.isError ? (
        <p className="px-4 py-5 text-body-sm text-[var(--color-error)]" role="alert">
          {filesQuery.error instanceof Error ? filesQuery.error.message : '读取 Workspace 文件失败'}
        </p>
      ) : !files || files.length === 0 || !selectedFile ? (
        <p className="px-4 py-5 text-body-sm text-[var(--color-on-surface-variant)]">
          暂无工具写入文件
        </p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col lg:grid lg:grid-cols-[minmax(9rem,2fr)_minmax(0,3fr)]">
          <nav
            aria-label="Workspace 文件列表"
            className="thin-scrollbar flex shrink-0 gap-1 overflow-x-auto border-b border-[var(--color-outline-variant)] p-2 lg:block lg:min-h-0 lg:overflow-y-auto lg:border-r lg:border-b-0"
          >
            {files.map((file) => (
              <button
                aria-pressed={file.path === selectedFile.path}
                className={cn(
                  'flex min-w-0 shrink-0 cursor-pointer items-center gap-2 rounded-sm px-3 py-2 text-left font-mono text-body-sm transition-colors duration-[var(--dur-s)] lg:mb-1 lg:w-full',
                  file.path === selectedFile.path
                    ? 'bg-[var(--color-primary-container)] text-[var(--color-on-primary-container)]'
                    : 'text-[var(--color-on-surface-variant)] hover:bg-[var(--color-state-hover)] hover:text-[var(--color-on-surface)]',
                )}
                key={file.path}
                onClick={() => setSelectedPath(file.path)}
                title={file.path}
                type="button"
              >
                <FileText aria-hidden="true" className="shrink-0" size={15} />
                <span className="truncate">{file.path}</span>
              </button>
            ))}
          </nav>
          <section
            aria-labelledby="debug-selected-file-title"
            className="flex min-h-0 min-w-0 flex-1 flex-col"
          >
            <h3
              className="shrink-0 border-b border-[var(--color-outline-variant)] px-4 py-3 font-mono text-body-sm font-semibold text-[var(--color-on-surface)]"
              id="debug-selected-file-title"
              title={selectedFile.path}
            >
              {selectedFile.path}
            </h3>
            {contentQuery.isError ? (
              <p className="px-4 py-5 text-body-sm text-[var(--color-error)]" role="alert">
                {contentQuery.error instanceof Error
                  ? contentQuery.error.message
                  : '读取工作区文件失败'}
              </p>
            ) : (
              <pre
                aria-busy={contentQuery.isPending}
                aria-labelledby="debug-selected-file-title"
                className="thin-scrollbar min-h-0 flex-1 overflow-auto bg-[var(--color-surface-container-low)] p-4 font-mono text-caption whitespace-pre-wrap text-[var(--color-on-surface)]"
                tabIndex={0}
              >
                {contentQuery.data?.content ?? ''}
              </pre>
            )}
          </section>
        </div>
      )}
    </aside>
  )
}
