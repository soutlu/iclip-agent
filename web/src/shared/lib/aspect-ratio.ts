/** 画幅档位：取需求单合同里的那份枚举，需求单与分镜页共用一份，顺序即下拉顺序。 */

import { zTaskVideoSpecInput } from '@/shared/api/generated/zod.gen'

export const ASPECT_RATIOS = zTaskVideoSpecInput.shape.aspect_ratio.unwrap().unwrap().options
