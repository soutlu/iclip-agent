/**
 * 产物类型注册表的组装处。
 *
 * 宿主在 `shared/`、渲染器在 `features/`，两边互不 import——把谁画什么接起来是 `app/` 层的活。
 * 加一种产物类型就是在这里多登记一条。
 */

import { SHOTS_PATH, StoryboardPanel } from '@/features/storyboard'
import { ArtifactRegistry } from '@/shared/workbench'

export const workbenchRegistry = new ArtifactRegistry()

workbenchRegistry.register({
  autoOpen: true,
  component: StoryboardPanel,
  match: { path: SHOTS_PATH },
  title: () => '分镜',
  type: 'storyboard',
})
