import { readFileSync } from 'node:fs'
import path from 'node:path'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import { createSameOriginApiProxy } from './vite/api-proxy'
import { resolveDevServerProfile } from './vite/dev-server-profile'

// dev/preview 同源代理：去掉 /api 前缀后转发到后端（后端路由挂根路径）。
// 生产环境反代（nginx）必须保持同一 rewrite 语义，见 docs/adr/0001。
const backendProxyTarget = process.env.VITE_BACKEND_PROXY_TARGET ?? 'http://127.0.0.1:7788'
const apiProxy = createSameOriginApiProxy(backendProxyTarget)

const APPLICATION_ENTRY = '/src/main.tsx'
const DEVELOPMENT_APPLICATION_ENTRY = '/src/testing/main.development.ts'
const MOCK_SERVICE_WORKER_PATH = path.resolve(
  import.meta.dirname,
  'node_modules/msw/lib/mockServiceWorker.js',
)

/** mock 模式的入口等待 MSW 就绪后再加载应用。 */
const developmentApplicationEntryPlugin = (): Plugin => ({
  apply: 'serve',
  name: 'cue-development-application-entry',
  transformIndexHtml(html) {
    return html.replace(APPLICATION_ENTRY, DEVELOPMENT_APPLICATION_ENTRY)
  },
})

/** 仅开发服务器提供 MSW worker，避免进入生产 public 产物。 */
const mockServiceWorkerPlugin = (): Plugin => ({
  apply: 'serve',
  configureServer(server) {
    server.middlewares.use((request, response, next) => {
      if (request.url?.split('?')[0] !== '/mockServiceWorker.js') {
        next()
        return
      }

      const workerSource = readFileSync(MOCK_SERVICE_WORKER_PATH)
      response.statusCode = 200
      response.setHeader('Content-Type', 'application/javascript; charset=utf-8')
      response.end(workerSource)
    })
  },
  name: 'cue-mock-service-worker',
})

export default defineConfig(({ mode }) => {
  const profile = resolveDevServerProfile(mode)
  const useBrowserMocks = profile.browserMocks !== 'disabled'

  return {
    plugins: [
      ...(useBrowserMocks ? [developmentApplicationEntryPlugin(), mockServiceWorkerPlugin()] : []),
      // tanstackRouter 必须在 react 插件之前
      tanstackRouter({ autoCodeSplitting: true, target: 'react' }),
      react(),
      tailwindcss(),
    ],
    preview: { proxy: apiProxy },
    resolve: {
      alias: {
        '@': path.resolve(import.meta.dirname, './src'),
      },
    },
    server: profile.proxyBackend ? { proxy: apiProxy } : {},
  }
})
