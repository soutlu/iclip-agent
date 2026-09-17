/** 画幅档位：取需求单合同里的那份枚举，需求单与分镜页共用一份，顺序即下拉顺序。
 *
 * 必须从生成物取、不能改写成手写数组：需求单表单靠它把输入 narrow 回合同枚举，
 * 手写一份就会在合同加档位时悄悄对不上。 */

import { zTaskVideoSpecInput } from '@/shared/api/generated/zod.gen'

export const ASPECT_RATIOS = zTaskVideoSpecInput.shape.aspect_ratio.unwrap().unwrap().options
