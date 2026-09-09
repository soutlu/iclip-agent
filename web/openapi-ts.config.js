import { defineConfig } from '@hey-api/openapi-ts'

// 从后端合同生成类型与 zod schema，pnpm contract:check 校验生成物。
export default defineConfig({
  input: '../contract/openapi.json',
  output: {
    path: process.env.ICLIP_CONTRACT_OUTPUT ?? 'src/shared/api/generated',
    postProcess: ['prettier'],
  },
  plugins: ['@hey-api/typescript', 'zod'],
})
