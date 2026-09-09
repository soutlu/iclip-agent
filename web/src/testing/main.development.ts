import { worker } from './mocks/browser'

const serviceWorker = { url: '/mockServiceWorker.js' }

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
