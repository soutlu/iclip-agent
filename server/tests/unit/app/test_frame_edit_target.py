"""帧编辑受理只允许属主使用未变更的镜头帧。"""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime
from unittest.mock import AsyncMock

import pytest

from iclip.app.conversation_workspace import ConversationWorkspace
from iclip.app.frame_edit_target import FrameEditTargetValidator
from iclip.common.errors import Conflict, NotFound, PermissionDenied, ValidationFailed
from iclip.domains.conversations.models import Conversation
from iclip.domains.conversations.repository import ConversationRepository
from iclip.domains.conversations.service import DerivedFileContent
from iclip.domains.generation.schemas import FrameEditContext
from tests.unit.domains.generation.test_frame_edit import edit_context
from tests.unit.domains.generation.test_generations_api import principal


def validator(owner: uuid.UUID) -> tuple[FrameEditTargetValidator, AsyncMock, AsyncMock, uuid.UUID]:
    conversation_id = uuid.uuid4()
    repo = AsyncMock(spec=ConversationRepository)
    repo.get.return_value = Conversation(
        id=conversation_id,
        owner_user_id=owner,
        agent_id="storyboard",
        title="test",
        title_kind="custom",
        last_run_id=None,
        task_id=None,
        collection_id=None,
        created_at=datetime.now(UTC),
        updated_at=datetime.now(UTC),
    )
    workspace = AsyncMock(spec=ConversationWorkspace)
    workspace.read_file.return_value = DerivedFileContent(
        path="video_shot.json",
        content=json.dumps(
            {
                "aspectRatio": "16:9",
                "shots": [
                    {
                        "index": 1,
                        "prompt": "move",
                        "seconds": 5,
                        "imageUrls": ["https://example.test/source.png"],
                    }
                ],
            }
        ),
        version=1,
    )
    return FrameEditTargetValidator(repo, workspace), repo, workspace, conversation_id


async def test_target_owner_and_current_source_are_checked_without_mutation() -> None:
    actor = principal("agent:run")
    check, repo, workspace, conversation_id = validator(actor.user_id)
    await check(actor, conversation_id, 1, FrameEditContext.model_validate(edit_context()))
    repo.get.assert_awaited_once_with(conversation_id, owner=actor.user_id)
    workspace.write_file.assert_not_awaited()


@pytest.mark.parametrize(
    "case",
    [
        "permission",
        "other_owner",
        "missing",
        "changed",
        "frame_missing",
        "invalid_document",
        "invalid_path",
    ],
)
async def test_invalid_target_is_rejected(case: str) -> None:
    actor = principal("agent:run", "users:manage") if case != "permission" else principal()
    check, _repo, workspace, conversation_id = validator(
        uuid.uuid4() if case == "other_owner" else actor.user_id
    )
    context = edit_context()
    expected: type[Exception] = Conflict
    if case in {"permission", "other_owner"}:
        expected = PermissionDenied
    elif case == "missing":
        workspace.read_file.return_value = None
        expected = NotFound
    elif case == "changed":
        context["sourceUrl"] = "https://example.test/stale.png"
    elif case == "frame_missing":
        context["frameNumber"] = 2
    elif case == "invalid_document":
        workspace.read_file.return_value = DerivedFileContent(
            path="video_shot.json", content="{}", version=1
        )
        expected = ValidationFailed
    else:
        context["artifactPath"] = "../video_shot.json"
        expected = ValidationFailed
    with pytest.raises(expected):
        await check(actor, conversation_id, 1, FrameEditContext.model_validate(context))
    workspace.write_file.assert_not_awaited()
