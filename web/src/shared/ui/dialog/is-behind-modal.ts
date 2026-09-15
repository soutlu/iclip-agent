/** Radix 模态层打开时会把弹窗以外的顶层节点标成 aria-hidden；落在这种节点里的组件被弹窗盖着，不该响应全局快捷键。 */
export const isBehindModal = (element: Element | null): boolean =>
  element !== null && element.closest('[aria-hidden="true"]') !== null
