/** 文件页只有两个画面：列表与阅读。正在看的文件路径放查询参数 file，刷新与分享都保留。 */

import { useNavigate, useSearch } from '@tanstack/react-router'
import { useWorkspaceFiles, type ArtifactRendererProps } from '@/shared/workbench'
import { FileList } from './file-list'
import { FileReader } from './file-reader'

export function WorkspaceFilesPanel({ conversationId }: ArtifactRendererProps) {
  const files = useWorkspaceFiles(conversationId)
  const search: { file?: string } = useSearch({ strict: false })
  const navigate = useNavigate()
  const show = (path: string | undefined) =>
    void navigate({
      search: (previous: Record<string, unknown>) => ({ ...previous, file: path }),
      to: '.',
    })

  if (search.file !== undefined) {
    return (
      <FileReader
        conversationId={conversationId}
        onBack={() => show(undefined)}
        path={search.file}
      />
    )
  }
  return (
    <FileList
      error={files.error?.message}
      files={files.data?.files}
      onOpen={show}
      pending={files.isPending}
    />
  )
}
