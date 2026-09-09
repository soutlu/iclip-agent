/** 阅读一份工作区文件：头上是返回、文件名、类型；正文按后缀选渲染器。 */

import { useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { ApiError } from '@/shared/api/client'
import { copyText } from '@/shared/lib/clipboard'
import { Button, IconButton } from '@/shared/ui/button'
import { Markdown } from '@/shared/ui/markdown'
import { Tag } from '@/shared/ui/tag'
import { toast } from '@/shared/ui/toast'
import { useWorkbenchRegistry, useWorkspaceFile } from '@/shared/workbench'
import { baseName, fileKindOf } from '../file-kind'
import { JsonTree } from './json-tree'
import { PanelNotice } from './panel-notice'
import { TextLines } from './text-lines'

type FileReaderProps = {
  conversationId: string
  path: string
  onBack: () => void
}

export function FileReader({ conversationId, onBack, path }: FileReaderProps) {
  const file = useWorkspaceFile(conversationId, path)
  const registry = useWorkbenchRegistry()
  const navigate = useNavigate()
  const kind = fileKindOf(path, file.data?.file.content)
  // JSON 默认看结构，想核对原文再切。
  const [raw, setRaw] = useState(false)
  // 这份文件若本身登记成了别的产物（比如分镜），给一个去那边看的入口；匹配只看路径，版本号只是凑齐类型。
  const own = registry.matchFiles([{ path, version: file.data?.file.version ?? 0 }])[0]

  const copy = async () => {
    if (file.data === undefined) return
    try {
      await copyText(file.data.file.content)
      toast.success('已复制')
    } catch {
      toast.error('复制失败')
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b-[0.5px] border-chat-hairline pr-2 pl-2">
        <IconButton label="返回文件列表" name="back" onClick={onBack} size="md" />
        <span className="min-w-0 truncate text-body font-medium text-on-surface">
          {baseName(path)}
        </span>
        <Tag className="shrink-0">{kind.label}</Tag>
        <span className="flex-1" />
        {own === undefined ? null : (
          <Button
            onClick={() =>
              void navigate({
                search: (previous: Record<string, unknown>) => ({ ...previous, artifact: own.id }),
                to: '.',
              })
            }
            size="md"
            variant="ghost"
          >
            在{own.title}里打开
          </Button>
        )}
        {kind.kind === 'json' && file.data !== undefined ? (
          <Button onClick={() => setRaw(!raw)} size="md" variant="ghost">
            {raw ? '看结构' : '看原文'}
          </Button>
        ) : null}
        <IconButton
          disabled={file.data === undefined}
          label="复制内容"
          name="copy"
          onClick={() => void copy()}
          size="md"
        />
      </div>

      {file.isPending ? (
        <PanelNotice text="正在读取文件…" />
      ) : file.isError ? (
        file.error instanceof ApiError && file.error.status === 404 ? (
          <PanelNotice hint="它已经被删掉了，回列表看看还有什么。" text="这个文件已经不在了" />
        ) : (
          <PanelNotice text={file.error.message} />
        )
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <FileBody kind={kind.kind} raw={raw} text={file.data.file.content} />
        </div>
      )}
    </div>
  )
}

function FileBody({
  kind,
  raw,
  text,
}: {
  kind: 'markdown' | 'json' | 'text'
  raw: boolean
  text: string
}) {
  if (kind === 'markdown') {
    return (
      <article className="px-6 py-5">
        <Markdown text={text} />
      </article>
    )
  }
  if (kind === 'json' && !raw) {
    return (
      <div className="px-4 py-4">
        <JsonTree text={text} />
      </div>
    )
  }
  return (
    <div className="px-4 py-4">
      <TextLines text={text} />
    </div>
  )
}
