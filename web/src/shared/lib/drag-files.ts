/** 拖放事件里带的是不是本机文件；页内元素、文字的拖动不算。 */
export const hasDraggedFiles = (event: { dataTransfer: DataTransfer | null }): boolean =>
  event.dataTransfer?.types.includes('Files') === true
