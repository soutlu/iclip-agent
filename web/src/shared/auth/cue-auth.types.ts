import type { z } from 'zod'
import type { zUserOut } from '@/shared/api/generated/zod.gen'

export type CueLoginRequest = {
  username: string
  password: string
}

export type CueAuthUser = z.output<typeof zUserOut>
