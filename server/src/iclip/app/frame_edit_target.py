"""将帧编辑目标检查接入对话归属和现有镜头文档。"""

from __future__ import annotations

import json
import uuid

from iclip.app.conversation_workspace import ConversationWorkspace
from iclip.capabilities.shot_video.delivery import validate_video_shots_document
from iclip.common.errors import Conflict, NotFound, PermissionDenied, ValidationFailed
from iclip.domains.conversations.repository import ConversationRepository
from iclip.domains.generation.schemas import FrameEditContext
from iclip.domains.identity.public import Principal
from iclip.platform.file_store.store import InvalidPath, normalize_path


class FrameEditTargetValidator:
    """只读检查目标；生成结果写回继续使用工作区文档的版本校验。"""

    def __init__(self, repo: ConversationRepository, workspace: ConversationWorkspace) -> None:
        self._repo = repo
        self._workspace = workspace

    async def __call__(
        self,
        principal: Principal,
        conversation_id: uuid.UUID,
        shot_index: int,
        context: FrameEditContext,
    ) -> None:
        if not principal.has("agent:run"):
            raise PermissionDenied("帧编辑需要 agent:run 权限")
        conversation = await self._repo.get(
            conversation_id, owner=None if principal.has("users:manage") else principal.user_id
        )
        if conversation.owner_user_id != principal.user_id:
            raise PermissionDenied("只能编辑自己的对话")
        try:
            if normalize_path(context.artifact_path) != context.artifact_path:
                raise ValidationFailed("帧编辑文件路径必须使用工作区中的规范路径")
        except InvalidPath as exc:
            raise ValidationFailed(str(exc)) from exc
        document = await self._workspace.read_file(
            conversation.owner_user_id, conversation_id, context.artifact_path
        )
        if document is None:
            raise NotFound("帧编辑目标文件不存在")
        try:
            validate_video_shots_document(document.content)
        except ValueError as exc:
            raise ValidationFailed("帧编辑目标不是有效的镜头文档") from exc
        shots = json.loads(document.content)["shots"]
        shot = next((item for item in shots if item["index"] == shot_index), None)
        if shot is None or context.frame_number > len(shot["imageUrls"]):
            raise Conflict("目标参考帧已不存在，请重新打开编辑器")
        if shot["imageUrls"][context.frame_number - 1] != context.source_url:
            raise Conflict("目标参考帧已改变，请重新打开编辑器")
