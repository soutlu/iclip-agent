import type { z } from 'zod'
import type { zUserOut } from '@/shared/api/generated/zod.gen'

export type ProducerLoginRequest = {
  username: string
  password: string
}

/** 当前用户：形状就是合同里的 UserOut，后端改字段由 contract:check 拦。 */
export type ProducerAuthUser = z.output<typeof zUserOut>
