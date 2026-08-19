import '@xyflow/react/dist/style.css'
import 'katex/dist/katex.min.css'
import '@/app/globals.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from '@/app/app'

const rootElement = document.getElementById('root')

if (!rootElement) {
  throw new Error('找不到 #root 挂载节点')
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
