"""对话那一侧要借工作区做的几件事：清地盘、记素材、列 / 读 / 写派生文件，外加交付表写回时的形状判定。"""

from __future__ import annotations

import uuid
from collections.abc import Sequence

from iclip.capabilities.shot_video.delivery import validate_video_shots_document
from iclip.capabilities.workspace.scope import namespace_for
from iclip.common.errors import Conflict, ValidationFailed
from iclip.domains.conversations.service import DerivedFile, DerivedFileContent
from iclip.platform.file_store.pg import PgFileStore
from iclip.platform.file_store.store import (
    FileStore,
    InvalidContent,
    InvalidPath,
    QuotaExceeded,
    VersionConflict,
    normalize_path,
)
from iclip.platform.material_ledger.store import Material, MaterialLedger
from iclip.platform.transcript.ops import ImageContent, PromptContent, VideoContent


class ConversationWorkspace:
    """对话那一侧要借工作区做的几件事，接在组合根，两边互不认识。

    对话不该知道工作区的存在，工作区也不该知道有「对话」这种东西。这个类是唯一同时
    认识两者的地方，它把「属主 + 对话 id」翻成命名空间。
    """

    def __init__(self, store: PgFileStore, announcing: FileStore, ledger: MaterialLedger) -> None:
        self._store = store
        self._announcing = announcing
        self._ledger = ledger

    async def purge(self, owner: uuid.UUID, conversation_id: uuid.UUID) -> None:
        """删掉一段对话时，连带清空它在工作区里的地盘与素材台账。"""

        namespace = namespace_for(owner, str(conversation_id))
        await self._store.purge_namespace(namespace)
        await self._ledger.purge_namespace(namespace)

    async def record_materials(
        self, owner: uuid.UUID, conversation_id: str, content: Sequence[PromptContent]
    ) -> None:
        """把一条消息带的附件登进素材台账，工具随后才收得下这些地址。"""

        materials = [
            Material(
                url=part.source.url,
                kind="image" if isinstance(part, ImageContent) else "video",
            )
            for part in content
            if isinstance(part, ImageContent | VideoContent) and part.source.url is not None
        ]
        await self._ledger.record(namespace_for(owner, conversation_id), materials)

    async def list_files(
        self, owner: uuid.UUID, conversation_id: uuid.UUID
    ) -> tuple[DerivedFile, ...]:
        """列出 agent 在一段对话里写下的文件，给界面上的工作区面板看。"""

        entries = await self._store.entries(namespace_for(owner, str(conversation_id)))
        return tuple(
            DerivedFile(
                path=entry.path,
                size_bytes=entry.size_bytes,
                version=entry.version,
                updated_at=entry.updated_at,
            )
            for entry in entries
        )

    async def read_file(
        self, owner: uuid.UUID, conversation_id: uuid.UUID, path: str
    ) -> DerivedFileContent | None:
        """读其中一个文件。路径是用户给的，不合语法就是 422，不能漏成 500。"""

        try:
            stored = await self._store.read(namespace_for(owner, str(conversation_id)), path)
        except InvalidPath as exc:
            raise ValidationFailed(str(exc)) from exc
        if stored is None:
            return None
        return DerivedFileContent(path=stored.path, content=stored.content, version=stored.version)

    async def write_file(
        self,
        owner: uuid.UUID,
        conversation_id: uuid.UUID,
        path: str,
        content: str,
        expected_version: int,
    ) -> DerivedFileContent:
        """整份写下其中一个文件，版本对不上就 409。

        **只收已经是规范形式的路径。** ``/video_shot.json`` 与 ``video_shot.json`` 会被
        存储层规范成同一个文件，而按路径挂的那张校验表是按字面量查的——放行不规范的写法
        就等于放出一条绕过校验的路。
        """

        try:
            if normalize_path(path) != path:
                raise ValidationFailed(f"路径 {path!r} 不是规范形式，按工作区文件列表里的写法给")
            entry = await self._announcing.write(
                namespace_for(owner, str(conversation_id)),
                path,
                content,
                expected_version=expected_version,
            )
        except VersionConflict as exc:
            raise Conflict(str(exc)) from exc
        except (InvalidPath, InvalidContent, QuotaExceeded) as exc:
            raise ValidationFailed(str(exc)) from exc
        return DerivedFileContent(path=entry.path, content=content, version=entry.version)


async def validate_video_shots(owner: uuid.UUID, conversation_id: uuid.UUID, content: str) -> None:
    """用户写回来的镜头组 prompt 表要过交付工具那套形状判定。

    这条线只能接在组合根：判定归镜头素材能力，而对话那一侧不认识它。判定不看 owner
    与对话——形状是形状，与这份文件属于谁无关。
    """

    _ = (owner, conversation_id)
    try:
        validate_video_shots_document(content)
    except ValueError as exc:
        raise ValidationFailed(str(exc)) from exc


__all__ = ["ConversationWorkspace", "validate_video_shots"]
