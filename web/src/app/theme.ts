/** 通过 <html> 的 .dark 统一切换主题；优先使用本地偏好，否则跟随系统。 */
const STORAGE_KEY = 'cue-theme'

type ThemePreference = 'light' | 'dark' | 'system'

const readStored = (): ThemePreference => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    return stored === 'light' || stored === 'dark' ? stored : 'system'
  } catch {
    // 站点存储不可用时跟随系统主题。
    return 'system'
  }
}

const prefersDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches

const apply = (preference: ThemePreference) => {
  const dark = preference === 'system' ? prefersDark() : preference === 'dark'
  document.documentElement.classList.toggle('dark', dark)
}

export function initTheme() {
  apply(readStored())
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (readStored() === 'system') apply('system')
  })
}
