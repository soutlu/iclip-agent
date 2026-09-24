/** 通过 <html> 的 .dark 统一切换主题，跟随系统配色偏好。 */
export function initTheme() {
  const query = window.matchMedia('(prefers-color-scheme: dark)')
  const apply = (dark: boolean) => document.documentElement.classList.toggle('dark', dark)
  apply(query.matches)
  query.addEventListener('change', (event) => apply(event.matches))
}
