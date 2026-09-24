/** 读取中的卡片占位：沿用卡片网格、封面高度与文字行高，读屏只读到 label。 */

// 与卡片文字区逐行对应：标题行 20px，其余三行 16px。
const LINES = [
  { row: 'h-5', bar: 'w-4/5' },
  { row: 'h-4', bar: 'w-3/5' },
  { row: 'h-4', bar: 'w-1/2' },
  { row: 'h-4', bar: 'w-1/3' },
] as const

export function TaskCardSkeletons({ count, label }: { count: number; label: string }) {
  return (
    <div className="grid-task-cards" role="status">
      <span className="sr-only">{label}</span>
      {Array.from({ length: count }, (_, index) => (
        <div aria-hidden="true" className="flex flex-col motion-safe:animate-pulse" key={index}>
          <div className="task-card-media rounded-md bg-surface-container-low" />
          <div className="flex flex-col gap-1 pt-2">
            {LINES.map(({ row, bar }) => (
              <div className={`flex items-center ${row}`} key={bar}>
                <div className={`h-3 rounded-xs bg-surface-container-low ${bar}`} />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
