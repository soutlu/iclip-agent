/** 按目录分组的文件列表：类型图标、文件名、大小与时间。点一行进阅读。 */

import { Icon } from '@/shared/icons'
import type { ConversationFileOut } from '@/shared/api/generated'
import { baseName, fileKindOf, formatBytes, formatWhen, groupByDirectory } from '../file-kind'
import { PanelNotice } from './panel-notice'

type FileListProps = {
  files: readonly ConversationFileOut[] | undefined
  pending: boolean
  error: string | undefined
  onOpen: (path: string) => void
}

export function FileList({ error, files, onOpen, pending }: FileListProps) {
  if (pending) return <PanelNotice text="正在读取文件…" />
  if (error !== undefined) return <PanelNotice text={error} />
  if (files === undefined || files.length === 0) {
    return <PanelNotice hint="agent 写下的每一份文件都会列在这里。" text="还没有文件" />
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-2">
      {groupByDirectory(files).map((group) => (
        <section aria-label={group.dir === '' ? '根目录' : group.dir} key={group.dir}>
          {group.dir === '' ? null : (
            <h3 className="flex items-center gap-1.5 px-2 pt-4 pb-1 font-mono text-label text-on-surface-faint">
              <Icon decorative name="folder" size="xs" />
              {group.dir}/
            </h3>
          )}
          <ul className="flex flex-col">
            {group.files.map((file) => {
              // 列表只有路径没有内容，无后缀的文件在这里按文本算，点开后再按内容开头细分。
              const kind = fileKindOf(file.path)
              return (
                <li key={file.path}>
                  <button
                    className="flex w-full ui-state cursor-pointer items-center gap-3 rounded-sm px-2 py-2 text-left ui-focus"
                    onClick={() => onOpen(file.path)}
                    type="button"
                  >
                    <Icon
                      className="shrink-0 text-on-surface-variant"
                      decorative
                      name={kind.icon}
                      size="md"
                    />
                    <span className="min-w-0 flex-1 truncate text-body text-on-surface">
                      {baseName(file.path)}
                    </span>
                    <span className="shrink-0 text-label text-on-surface-faint tabular-nums">
                      {formatBytes(file.sizeBytes)} · {formatWhen(file.updatedAt)}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </section>
      ))}
    </div>
  )
}
