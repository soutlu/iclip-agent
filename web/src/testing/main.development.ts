import { worker } from './mocks/browser'

const serviceWorker = { url: '/mockServiceWorker.js' }

/**
 * 启动当前开发模式需要的浏览器 MSW 后再挂载应用。
 *
 * @returns 应用完成挂载时的 Promise。
 */
const startDevelopmentApplication = async () => {
  await worker.start({
    onUnhandledRequest(request, print) {
      if (new URL(request.url).pathname.startsWith('/api/')) {
        print.error()
      }
    },
    serviceWorker,
  })

  await import('../main')
}

void startDevelopmentApplication()
