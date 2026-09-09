import '@/app/globals.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '@/app/app'
import { initTheme } from '@/app/theme'

const rootElement = document.getElementById('root')

if (!rootElement) {
  throw new Error('找不到 #root 挂载节点')
}

// 挂载前应用主题，避免首屏闪烁。
initTheme()

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
