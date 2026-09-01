/**
 * ProseMirror 输入框的测试动作。
 *
 * jsdom 不会真正编辑 contenteditable，逐字敲键盘进不了 PM 的文档；粘贴走的是 PM 自己的
 * 事务管线（handlePaste → 读 clipboardData → insertText），效果等同打字。文件粘贴同理，
 * 只是 clipboardData 里带的是 files。
 */

import { fireEvent } from '@testing-library/react'

/** 往输入框里粘一段纯文字（等同打字输入）。 */
export const pasteTextIntoComposer = (editor: HTMLElement, text: string) => {
  fireEvent.paste(editor, {
    clipboardData: {
      files: [],
      getData: (type: string) => (type === 'text/plain' ? text : ''),
      types: ['text/plain'],
    },
  })
}

/** 往输入框里粘文件（剪贴板图片那条路）。 */
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

/** 把文件拖进窗口再松手（返回有没有被 composer 收下）。 */
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
