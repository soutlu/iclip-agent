/** 等宽带行号的纯文本：没有专门渲染器的文件，以及 JSON 的原文视图。 */

export function TextLines({ text }: { text: string }) {
  const rows = text.split('\n').map((line, index) => ({ no: String(index + 1), text: line }))
  return (
    <div className="grid grid-cols-[auto_1fr] gap-x-4 font-mono text-body-sm leading-relaxed">
      {rows.map((row) => (
        <div className="contents" key={row.no}>
          <span className="text-right text-on-surface-faint tabular-nums select-none">
            {row.no}
          </span>
          <span className="min-w-0 wrap-anywhere whitespace-pre-wrap text-on-surface">
            {row.text}
          </span>
        </div>
      ))}
    </div>
  )
}
