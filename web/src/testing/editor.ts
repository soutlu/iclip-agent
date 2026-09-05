/** jsdom 不编辑 contenteditable，使用粘贴事件进入 ProseMirror 的事务管线。 */

import { fireEvent } from '@testing-library/react'

export const pasteTextIntoComposer = (editor: HTMLElement, text: string) => {
  fireEvent.paste(editor, {
    clipboardData: {
      files: [],
      getData: (type: string) => (type === 'text/plain' ? text : ''),
      types: ['text/plain'],
    },
  })
}

export const pasteFilesIntoComposer = (editor: HTMLElement, files: File[]) => {
  fireEvent.paste(editor, {
    clipboardData: {
      files,
      getData: () => '',
      items: files.map((file) => ({
        kind: 'file',
        type: file.type,
        webkitGetAsEntry: () => null,
      })),
      types: ['Files'],
    },
  })
}

export const dropFilesIntoWindow = (files: File[]) => {
  const dataTransfer = {
    files,
    items: files.map((file) => ({
      kind: 'file',
      type: file.type,
      webkitGetAsEntry: () => null,
    })),
    types: ['Files'],
  }
  fireEvent.dragEnter(window, { dataTransfer })
  fireEvent.drop(window, { dataTransfer })
}
