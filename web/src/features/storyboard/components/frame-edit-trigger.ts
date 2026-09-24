/** 找到某一组里「编辑图片」的入口：组的 `aria-label` 由 reader-page 给，`data-frame-edit` 标在
 * frame-preview 的那个按钮上。图片编辑器关掉时点开它的角标可能已经不在，焦点退到这里。 */
export const frameEditTriggerSelector = (shotIndex: number) =>
  `[aria-label="镜头组 ${shotIndex}"] [data-frame-edit]`
