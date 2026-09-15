import { useState } from 'react'

/** 内容没变就沿用上一次的引用。
 *
 * 段列表每次渲染都从查询结果重算，引用天天换；播放器靠引用判断「换了一组段」来归零，
 * 拿到新引用就会把正在放的停下来。这里按内容比较，只有真换了段才给新数组。 */
export const useStableValue = <T>(value: T): T => {
  const key = JSON.stringify(value)
  const [stable, setStable] = useState({ key, value })
  if (stable.key === key) return stable.value
  setStable({ key, value })
  return value
}
