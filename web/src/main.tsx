import '@xyflow/react/dist/style.css'
import '@/app/globals.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from '@/app/app'
import { initTheme } from '@/app/theme'

const rootElement = document.getElementById('root')

if (!rootElement) {
  throw new Error('找不到 #root 挂载节点')
}

// 先定主题再挂载，避免首屏用错档的颜色闪一下
initTheme()

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
