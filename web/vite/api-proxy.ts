import type { ProxyOptions } from 'vite'

const API_PREFIX = /^\/api/

export const createSameOriginApiProxy = (
  backendProxyTarget: string,
): Record<string, ProxyOptions> => ({
  '/api': {
    // 保留浏览器可见 Host，使 WS 的 Origin 与 Host 在后端同源校验中保持一致。
    changeOrigin: false,
    rewrite: (requestPath: string) => requestPath.replace(API_PREFIX, ''),
    target: backendProxyTarget,
    ws: true,
  },
})
