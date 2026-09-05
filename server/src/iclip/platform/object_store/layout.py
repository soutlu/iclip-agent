"""公开对象 key 的统一布局；所有对象位于 iclip/agent 命名空间。

key 按业务 id 或内容摘要稳定生成，用于幂等写入。
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Final

OSS_ROOT: Final = "iclip/agent"
"""本服务在共享桶中的命名空间，由 OSS 适配器校验边界。"""


@dataclass(frozen=True, slots=True)
class MediaPaths:
    """统一生成对象 key，调用方通过组合根共享同一实例。"""

    def chat_media(self, *, digest: str, ext: str) -> str:
        """按内容摘要命名聊天媒体。"""

        return f"{OSS_ROOT}/chat-media/{digest}.{ext}"

    def generated_image(self, *, job_id: uuid.UUID, ext: str) -> str:

        return f"{OSS_ROOT}/generated-images/{job_id}.{ext}"

    def generated_video(self, *, job_id: uuid.UUID, ext: str) -> str:

        return f"{OSS_ROOT}/generated-videos/{job_id}.{ext}"

    def shot_board(self, *, extraction_key: str, index: int) -> str:
        """按取帧键分目录，使同一视频与镜头表复用预览板。"""

        return f"{OSS_ROOT}/shot-frames/{extraction_key}/board/{index}.jpg"

    def shot_cell(self, *, job_id: uuid.UUID, cell_id: str) -> str:

        return f"{OSS_ROOT}/shot-frames/{job_id}/out/{cell_id}.jpg"

    def anchor_sheet(self, *, job_id: uuid.UUID, index: int) -> str:

        return f"{OSS_ROOT}/anchor-sheets/{job_id}/{index}.jpg"

    def task_style_cover(self, *, digest: str, ext: str) -> str:
        """按源 URL 摘要命名需求单封面，复用同一产品图片。"""

        return f"{OSS_ROOT}/task-styles/{digest}.{ext}"

    def upload(self, *, asset_id: uuid.UUID, ext: str) -> str:

        return f"{OSS_ROOT}/uploads/{asset_id}.{ext}"

    def upload_prefix(self, *, asset_id: uuid.UUID) -> str:
        """按 assetId 查找上传对象；扩展名从桶读取，不接受客户端声明。"""

        return f"{OSS_ROOT}/uploads/{asset_id}."


MEDIA_PATHS: Final = MediaPaths()
"""共享布局实例；harness 与 capability 通过组合根注入。"""


__all__ = ["MEDIA_PATHS", "OSS_ROOT", "MediaPaths"]
