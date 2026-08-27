import { z } from 'zod'

// 环境变量唯一入口：新增 VITE_* 变量先在此声明 schema，业务代码只从 env 对象读取。
const EnvSchema = z.object({})

export const env = EnvSchema.parse(import.meta.env)
