import { z } from 'zod'

// 环境变量唯一入口：新增变量先在此声明 schema，业务代码只从 env 对象读取。
const EnvSchema = z.object({
  // AG-UI target 组件路径（/agui/agents/<id> 或 /agui/teams/<id>），同时派生 session target id。
  VITE_AGUI_TARGET_PATH: z.string().default('/agui/teams/producer'),
})

export const env = EnvSchema.parse(import.meta.env)
