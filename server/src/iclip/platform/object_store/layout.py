"""公开桶里的完整布局：本服务写进去的每一个对象，key 都由这里发。

桶是公司共用的，所以我们写的东西全部落在 ``iclip/agent/`` 这一层命名空间下面::

    <公开桶>/
    └── iclip/agent/
        ├── chat-media/{sha256}.{ext}                     聊天里内嵌上传的媒体
        ├── generated-images/{jobId}.{ext}                图片生成结果转存
        ├── shot-frames/{extractionKey}/board/{n}.jpg     参考片的取帧预览板
        ├── shot-frames/{jobId}/out/{cellId}.jpg          出图整图切出来的镜头帧
        ├── anchor-sheets/{jobId}/{n}.jpg                 补拍设定图切格
        ├── task-styles/{sha256}.{ext}                    需求单封面（主款首图转存）
        └── uploads/{assetId}.{ext}                       用户上传的素材

每一段文件名都从某个 id 或某段内容算出来，没有一个是调用方起的名字：地址要么按业务
id 幂等（同一次任务重跑落回同一个 key），要么按内容幂等（同一份字节永远同一个地址）。

**布局只在这一个文件里。** 写入方拿到的是算好的整根 key，自己不拼前缀——散在各处
拼字符串的话，「我们在桶里占了哪些地方」这个问题就只能靠 grep 回答。
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Final

OSS_ROOT: Final = "iclip/agent"
"""本服务在共用桶里的命名空间。所有 key 都以它开头，越界的由 ``oss.py`` 挡下。"""


@dataclass(frozen=True, slots=True)
class MediaPaths:
    """桶布局的唯一事实源。

    组合根造一个，递给所有写入方；各方按自己需要的那几个方法声明协议，不认识别人
    往哪写。
    """

    def chat_media(self, *, digest: str, ext: str) -> str:
        """聊天内嵌媒体物化后的落点，按内容摘要定名。"""

        return f"{OSS_ROOT}/chat-media/{digest}.{ext}"

    def generated_image(self, *, job_id: uuid.UUID, ext: str) -> str:
        """图片生成结果转存后的落点。"""

        return f"{OSS_ROOT}/generated-images/{job_id}.{ext}"

    def shot_board(self, *, extraction_key: str, index: int) -> str:
        """取帧预览板。按取帧键分目录——同一段视频同一套镜头行只取一次帧。"""

        return f"{OSS_ROOT}/shot-frames/{extraction_key}/board/{index}.jpg"

    def shot_cell(self, *, job_id: uuid.UUID, cell_id: str) -> str:
        """出图整图切出来的一格。"""

        return f"{OSS_ROOT}/shot-frames/{job_id}/out/{cell_id}.jpg"

    def anchor_sheet(self, *, job_id: uuid.UUID, index: int) -> str:
        """补拍设定图切出来的一格。"""

        return f"{OSS_ROOT}/anchor-sheets/{job_id}/{index}.jpg"

    def task_style_cover(self, *, digest: str, ext: str) -> str:
        """需求单封面。按**源地址**摘要定名：同一张产品图被多少张需求单引用都只搬一次。"""

        return f"{OSS_ROOT}/task-styles/{digest}.{ext}"

    def upload(self, *, asset_id: uuid.UUID, ext: str) -> str:
        """用户上传的素材。"""

        return f"{OSS_ROOT}/uploads/{asset_id}.{ext}"

    def upload_prefix(self, *, asset_id: uuid.UUID) -> str:
        """登记时按它去桶里找那个对象。

        扩展名不在这条前缀里：登记只收 assetId，扩展名得从桶里的对象自己身上读回
        来，不能由调用方报。
        """

        return f"{OSS_ROOT}/uploads/{asset_id}."


MEDIA_PATHS: Final = MediaPaths()
"""唯一那一份。

够得着这个模块的（业务域）直接用它；够不着的（harness 与 capability 那两环不认识
platform）由组合根把同一个实例递进去。
"""


__all__ = ["MEDIA_PATHS", "OSS_ROOT", "MediaPaths"]
