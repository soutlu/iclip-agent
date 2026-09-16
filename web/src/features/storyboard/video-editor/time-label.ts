/** 秒数写成 `mm:ss.ss`，播放器、时间线与选段共用一种写法。 */
export const timeLabel = (seconds: number): string => {
  const safe = Math.max(0, seconds)
  const minutes = Math.floor(safe / 60)
    .toString()
    .padStart(2, '0')
  return `${minutes}:${(safe % 60).toFixed(2).padStart(5, '0')}`
}

/** 秒数保留两位小数，去掉尾零：给刻度与输入框。 */
export const roundSeconds = (seconds: number): number => Math.round(seconds * 100) / 100
