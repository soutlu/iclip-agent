"""对话与工作区的适配：文件读写、素材登记、派生数据清理及文档校验。"""

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
    """在组合根将属主与对话 id 转换为工作区命名空间，隔离两侧领域知识。"""

    def __init__(self, store: PgFileStore, announcing: FileStore, ledger: MaterialLedger) -> None:
        self._store = store
        self._announcing = announcing
        self._ledger = ledger

    async def purge(self, owner: uuid.UUID, conversation_id: uuid.UUID) -> None:
        """清理对话工作区与素材台账。"""

        namespace = namespace_for(owner, str(conversation_id))
        await self._store.purge_namespace(namespace)
        await self._ledger.purge_namespace(namespace)

    async def record_materials(
        self, owner: uuid.UUID, conversation_id: str, content: Sequence[PromptContent]
    ) -> None:
        """登记用户附件，使工具可按素材来源规则使用其地址。"""

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
        """读取工作区文件，路径格式错误转换为 422。"""

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
        """按期望版本覆盖文件，冲突返回 409。

        仅接受规范路径，避免存储层归一化后的路径绕过按原始路径匹配的文档校验。"""

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
    """使用交付工具的同一解析器校验用户写回的镜头组 prompt 表。"""

    _ = (owner, conversation_id)
    try:
        validate_video_shots_document(content)
    except ValueError as exc:
        raise ValidationFailed(str(exc)) from exc


__all__ = ["ConversationWorkspace", "validate_video_shots"]
