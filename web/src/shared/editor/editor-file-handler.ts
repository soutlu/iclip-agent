import FileHandler from '@tiptap/extension-file-handler'

type ConfigureEditorFileHandlerOptions = {
  onFilesSelected: (files: File[]) => void
}

/**
 * 配置所有可接收媒体的编辑器共用的官方 FileHandler 行为。
 *
 * @param options - 文件选择回调。
 * @returns 同时接管粘贴和拖放文件的 Tiptap FileHandler extension。
 */
export const configureEditorFileHandler = ({
  onFilesSelected,
}: ConfigureEditorFileHandlerOptions) =>
  FileHandler.configure({
    consumePasteEvent: true,
    onDrop: (_editor, files) => {
      onFilesSelected(files)
    },
    onPaste: (_editor, files) => {
      onFilesSelected(files)
    },
  })
