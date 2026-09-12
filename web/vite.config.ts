import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import { createSameOriginApiProxy } from './vite/api-proxy'
import { resolveDevServerProfile } from './vite/dev-server-profile'

// dev/preview 同源代理：去掉 /api 前缀后转发到后端（后端路由挂根路径）。
// 生产环境反代（nginx）必须保持同一 rewrite 语义，见 ../contract/conventions.md。
const backendProxyTarget = process.env.VITE_BACKEND_PROXY_TARGET ?? 'http://127.0.0.1:7788'
const apiProxy = createSameOriginApiProxy(backendProxyTarget)

const APPLICATION_ENTRY = '/src/main.tsx'
const DEVELOPMENT_APPLICATION_ENTRY = '/src/testing/main.development.ts'
const MOCK_SERVICE_WORKER_PATH = path.resolve(
  import.meta.dirname,
  'node_modules/msw/lib/mockServiceWorker.js',
)

/** mock 模式的入口等待 MSW 就绪后再加载应用；构建时要在脚本标签被收集前替换，所以放在 pre。 */
const developmentApplicationEntryPlugin = (): Plugin => ({
  name: 'cue-development-application-entry',
  transformIndexHtml: {
    handler: (html) => html.replace(APPLICATION_ENTRY, DEVELOPMENT_APPLICATION_ENTRY),
    order: 'pre',
  },
})

const serveMockServiceWorker = (
  request: IncomingMessage,
  response: ServerResponse,
  next: () => void,
) => {
  if (request.url?.split('?')[0] !== '/mockServiceWorker.js') {
    next()
    return
  }

  response.statusCode = 200
  response.setHeader('Content-Type', 'application/javascript; charset=utf-8')
  response.end(readFileSync(MOCK_SERVICE_WORKER_PATH))
}

/** 只在 mock 模式下由 dev/preview 服务器提供 MSW worker，不进入 public 与生产产物。 */
const mockServiceWorkerPlugin = (): Plugin => ({
  configurePreviewServer(server) {
    server.middlewares.use(serveMockServiceWorker)
  },
  configureServer(server) {
    server.middlewares.use(serveMockServiceWorker)
  },
  name: 'cue-mock-service-worker',
})

export default defineConfig(({ mode }) => {
  const profile = resolveDevServerProfile(mode)
  const useBrowserMocks = profile.browserMocks !== 'disabled'

  return {
    // mock 构建只供 e2e 的 preview 使用，与生产产物分目录，互不覆盖。
    build: useBrowserMocks ? { outDir: 'dist-mock' } : {},
    plugins: [
      ...(useBrowserMocks ? [developmentApplicationEntryPlugin(), mockServiceWorkerPlugin()] : []),
      // tanstackRouter 必须在 react 插件之前
      tanstackRouter({ autoCodeSplitting: true, target: 'react' }),
      react(),
      tailwindcss(),
    ],
    preview: profile.proxyBackend ? { proxy: apiProxy } : {},
    resolve: {
      alias: {
        '@': path.resolve(import.meta.dirname, './src'),
      },
    },
    server: profile.proxyBackend ? { proxy: apiProxy } : {},
  }
})
