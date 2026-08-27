/**
 * 主题开关：唯一负责给 <html> 加减 .dark 的地方。
 *
 * 深色靠 CSS 变量整体换档（base.css 的 .dark 块），组件不感知当前主题，也不自持主题状态。
 * 用户没选过就跟随系统偏好，选过就以 localStorage 里的选择为准。
 */
const STORAGE_KEY = 'producer-theme'

export type ThemePreference = 'light' | 'dark' | 'system'

const readStored = (): ThemePreference => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    return stored === 'light' || stored === 'dark' ? stored : 'system'
  } catch {
    // 隐私模式下 localStorage 会抛，视作没选过
    return 'system'
  }
}

const prefersDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches

const apply = (preference: ThemePreference) => {
  const dark = preference === 'system' ? prefersDark() : preference === 'dark'
  document.documentElement.classList.toggle('dark', dark)
}

/** 记住用户选择并立即生效；传 'system' 表示交还给系统偏好 */
export function setTheme(preference: ThemePreference) {
  try {
    if (preference === 'system') localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, preference)
  } catch {
    // 存不下也不影响本次生效
  }
  apply(preference)
}

export function getTheme(): ThemePreference {
  return readStored()
}

/** 启动时调用一次：定好初始主题，并让「跟随系统」这档真的跟着系统走 */
export function initTheme() {
  apply(readStored())
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (readStored() === 'system') apply('system')
  })
}
