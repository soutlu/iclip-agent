type PanelNoticeProps = {
  text: string
  hint?: string
}

/** 面板正中一句状态：读取中、出错、空态。 */
export function PanelNotice({ hint, text }: PanelNoticeProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 px-6 text-center">
      <p className="text-body text-on-surface-variant">{text}</p>
      {hint === undefined ? null : <p className="text-body-sm text-on-surface-faint">{hint}</p>}
    </div>
  )
}
