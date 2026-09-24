export const PLATFORM_OPTIONS = [{ value: 'douyin', label: '抖音' }]

/** 标题里常见的平台简称；卡片省略与平台字段重复的前缀时按这张表认。 */
export const PLATFORM_ALIASES: Readonly<Record<string, readonly string[]>> = {
  amazon: ['amz'],
}
export const VIDEO_TYPE_OPTIONS = [{ value: 'product_showcase', label: '产品展示' }]
export const CONTENT_TYPE_OPTIONS = [{ value: 'short_video', label: '短视频' }]

export const videoSpecLabel = (value: string, options: { value: string; label: string }[]) =>
  options.find((option) => option.value === value)?.label ?? value
