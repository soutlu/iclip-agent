import path from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// 单测配置独立于 vite.config.ts：不需要路由生成、tailwind 与代理，只要 JSX 与 @ 别名。
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    passWithNoTests: true,
    restoreMocks: true,
    setupFiles: ['src/testing/setup.ts'],
  },
})
