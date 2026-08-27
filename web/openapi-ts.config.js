import { defineConfig } from '@hey-api/openapi-ts'

// 输入是后端导出的合同（make contract 生成），输出是类型 + zod schema。
// 生成物入库：前端构建不依赖能跑起来的后端，漂移由 pnpm contract:check 拦。
export default defineConfig({
  input: '../contract/openapi.json',
  output: {
    path: process.env.ICLIP_CONTRACT_OUTPUT ?? 'src/shared/api/generated',
    postProcess: ['prettier'],
  },
  plugins: ['@hey-api/typescript', 'zod'],
})
