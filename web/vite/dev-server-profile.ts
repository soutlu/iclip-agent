type BrowserMockProfile = 'disabled' | 'full'

export type DevServerProfile = {
  browserMocks: BrowserMockProfile
  proxyBackend: boolean
}

/**
 * 解析 Vite mode 对应的后端与浏览器 mock 组合。
 *
 * @param mode - 当前 Vite mode。
 * @returns 开发服务器 profile。
 */
export const resolveDevServerProfile = (mode: string): DevServerProfile => {
  if (mode === 'mock') {
    return { browserMocks: 'full', proxyBackend: false }
  }

  // development 是 Vite 的默认 mode：裸跑 `vite` 或工具（knip 等）加载配置时会用它
  if (['backend', 'development', 'production', 'test'].includes(mode)) {
    return { browserMocks: 'disabled', proxyBackend: true }
  }

  throw new Error(`未知 Vite mode：${mode}`)
}
