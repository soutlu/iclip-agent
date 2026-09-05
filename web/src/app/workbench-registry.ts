/** app 层连接 shared 宿主与 feature 渲染器，避免 shared 反向依赖 feature。 */

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
