/** 右侧面板选中哪件产物记在地址的查询参数上，刷新与分享都保留；读写都经这里。 */

import { useNavigate, useSearch } from '@tanstack/react-router'

/** 查询参数名；会话路由的 search schema 用同一个键声明它。 */
export const ARTIFACT_SEARCH_KEY = 'artifact'

type ArtifactSearch = { [ARTIFACT_SEARCH_KEY]?: string }

/** 地址点名的产物 id；没点名是 undefined。 */
export const useArtifactSearch = (): string | undefined => {
  const search: ArtifactSearch = useSearch({ strict: false })
  return search[ARTIFACT_SEARCH_KEY]
}

/** 在地址上点名一件产物，其余查询参数原样保留。 */
export const useOpenArtifact = () => {
  const navigate = useNavigate()
  return (artifactId: string) =>
    navigate({
      search: (previous) => ({ ...previous, [ARTIFACT_SEARCH_KEY]: artifactId }),
      to: '.',
    })
}
