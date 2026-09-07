"""帧编辑输入身份、顺序、受理和恢复的合同。"""

from __future__ import annotations

import uuid
from copy import deepcopy
from typing import Any
from unittest.mock import AsyncMock

import pytest
from pydantic import ValidationError

from iclip.common.errors import Conflict, NotFound
from iclip.domains.generation.schemas import (
    FrameEditAnnotation,
    ImageGenerationIn,
    request_from_payload,
    request_to_payload,
)
from iclip.domains.generation.service import GenerationService
from tests.helpers.generation import InMemoryGenerationRepository, image_request, make_job
from tests.unit.domains.generation.test_generation_queue import build_queue
from tests.unit.domains.generation.test_generations_api import build_test_app, client, principal


def edit_context() -> dict[str, Any]:
    return {
        "artifactPath": "video_shot.json",
        "frameNumber": 1,
        "sourceUrl": "https://example.test/source.png",
        "annotations": [
            {
                "id": "a",
                "number": 3,
                "kind": "ellipse",
                "points": [{"x": 0.1, "y": 0.2}, {"x": 0.5, "y": 0.6}],
            }
        ],
        "instructions": [
            {"kind": "text", "text": "将 "},
            {"kind": "annotation", "id": "a"},
            {"kind": "text", "text": " 换成 "},
            {"kind": "referenceImage", "id": "r"},
        ],
        "references": [
            {
                "id": "r",
                "kind": "image",
                "url": "https://example.test/reference.png",
                "label": "参考图",
            },
            {
                "id": "marked",
                "kind": "annotated",
                "url": "https://example.test/marked.png",
                "label": "标注图",
            },
        ],
    }


def edit_request(context: dict[str, Any] | None = None, **overrides: Any) -> ImageGenerationIn:
    context = context if context is not None else edit_context()
    return image_request(
        frame_edit=context,
        reference_image_urls=[ref["url"] for ref in context["references"]],
        **overrides,
    )


@pytest.mark.parametrize("kind", ["point", "ellipse"])
def test_compile_tracks_current_image_order_and_preserves_literal_text(kind: str) -> None:
    context = edit_context()
    context["annotations"][0]["kind"] = kind
    if kind == "point":
        context["annotations"][0]["points"] = [{"x": 0.1, "y": 0.2}]
    request = edit_request(context)
    assert request.frame_edit is not None
    assert request.frame_edit.compile_prompt().startswith(
        "将 【输入图片 2 中的标注 3】 换成 【输入图片 1】"
    )
    context["references"].reverse()
    reordered = edit_request(context)
    assert reordered.frame_edit is not None
    assert reordered.frame_edit.compile_prompt().startswith(
        "将 【输入图片 1 中的标注 3】 换成 【输入图片 2】"
    )
    assert request_from_payload("image", request_to_payload(request)) == request


@pytest.mark.parametrize(
    ("kind", "point_count", "valid"),
    [
        ("point", 0, False),
        ("point", 1, True),
        ("point", 2, False),
        ("rectangle", 1, False),
        ("rectangle", 2, True),
        ("rectangle", 3, False),
        ("ellipse", 1, False),
        ("ellipse", 2, True),
        ("ellipse", 3, False),
        ("arrow", 1, False),
        ("arrow", 2, True),
        ("arrow", 3, False),
        ("pen", 1, False),
        ("pen", 2, True),
        ("pen", 3, True),
    ],
)
def test_annotation_geometry_requires_points_for_its_tool(
    kind: str, point_count: int, valid: bool
) -> None:
    annotation = {
        "id": "a",
        "number": 1,
        "kind": kind,
        "points": [{"x": 0.1 * index, "y": 0.2} for index in range(point_count)],
    }
    if valid:
        assert FrameEditAnnotation.model_validate(annotation).model_dump() == annotation
    else:
        with pytest.raises(ValidationError):
            FrameEditAnnotation.model_validate(annotation)


@pytest.mark.parametrize(
    "invalid",
    [
        "annotation_id",
        "reference_id",
        "duplicate_id",
        "duplicate_number",
        "missing_marked",
        "multiple_marked",
        "point_bounds",
        "shape_points",
        "empty_instruction",
    ],
)
def test_invalid_edits_rejected_before_submission(invalid: str) -> None:
    context = edit_context()
    if invalid == "annotation_id":
        context["instructions"][1]["id"] = "missing"
    elif invalid == "reference_id":
        context["instructions"][3]["id"] = "missing"
    elif invalid == "duplicate_id":
        context["references"][1]["id"] = "r"
    elif invalid == "duplicate_number":
        other = deepcopy(context["annotations"][0])
        other["id"] = "other"
        context["annotations"].append(other)
    elif invalid == "missing_marked":
        context["references"].pop()
    elif invalid == "multiple_marked":
        context["references"][0]["kind"] = "annotated"
    elif invalid == "point_bounds":
        context["annotations"][0]["points"][0]["x"] = 1.1
    elif invalid == "shape_points":
        context["annotations"][0]["points"].append({"x": 0, "y": 0})
    else:
        context["instructions"] = [{"kind": "text", "text": "  "}]
    with pytest.raises(ValidationError):
        edit_request(context)


def test_request_cannot_disagree_with_user_order() -> None:
    with pytest.raises(ValidationError, match="顺序"):
        image_request(
            frame_edit=edit_context(), reference_image_urls=["https://example.test/source.png"]
        )


@pytest.mark.parametrize("kind", ["point", "ellipse"])
async def test_submission_validates_target_before_queue_and_persists_snapshot(kind: str) -> None:
    repo = InMemoryGenerationRepository()
    queue, _ = build_queue(repo)
    validate = AsyncMock()
    service = GenerationService(
        repo,
        queue,
        video_provider_name="video",
        image_provider_name="image",
        video_model="video",
        video_allowed_models=("video",),
        validate_frame_edit_target=validate,
    )
    context = edit_context()
    context["annotations"][0]["kind"] = kind
    if kind == "point":
        context["annotations"][0]["points"] = [{"x": 0.1, "y": 0.2}]
    request = edit_request(context, conversation_id=uuid.uuid4(), shot_index=1)
    actor = principal("generation:submit", "agent:run")
    job = await service.submit(actor, request)
    validate.assert_awaited_once_with(actor, request.conversation_id, 1, request.frame_edit)
    assert isinstance(job.request, ImageGenerationIn)
    assert job.request.reference_image_urls == request.reference_image_urls
    assert job.request.frame_edit == request.frame_edit
    assert request.frame_edit is not None
    assert job.request.prompt == request.frame_edit.compile_prompt()
    validate.side_effect = Conflict("底图已改变")
    with pytest.raises(Conflict):
        await service.submit(actor, request)
    assert len(repo.jobs) == 1


async def test_frame_history_filters_before_limit_and_cursor_is_owner_scoped() -> None:
    actor = principal("generation:read")
    conversation_id = uuid.uuid4()
    first = make_job(
        edit_request(), owner_user_id=actor.user_id, conversation_id=conversation_id, shot_index=1
    )
    second = make_job(
        edit_request(), owner_user_id=actor.user_id, conversation_id=conversation_id, shot_index=1
    )
    other_frame = edit_context()
    other_frame["frameNumber"] = 2
    unrelated = make_job(
        edit_request(other_frame),
        owner_user_id=actor.user_id,
        conversation_id=conversation_id,
        shot_index=1,
    )
    foreign = make_job(edit_request(), conversation_id=conversation_id, shot_index=1)
    repo = InMemoryGenerationRepository([first, second, unrelated, foreign])
    app = build_test_app(repo, granted=actor)
    params = {
        "kind": "image",
        "artifactPath": "video_shot.json",
        "shotIndex": 1,
        "frameNumber": 1,
        "conversationId": str(conversation_id),
        "limit": 1,
    }
    async with client(app) as http:
        page = await http.get("/generations", params=params)
        assert page.status_code == 200
        assert [item["id"] for item in page.json()["items"]] == [str(second.id)]
        page = await http.get("/generations", params={**params, "before": str(second.id)})
        assert [item["id"] for item in page.json()["items"]] == [str(first.id)]
        denied = await http.get("/generations", params={**params, "before": str(foreign.id)})
        assert denied.status_code == 404
    with pytest.raises(NotFound):
        await repo.get(foreign.id, owner=actor.user_id)
