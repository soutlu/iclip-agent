"""连接级帧的序列化契约：空字段整个省略，客户端 schema 按可选处理。"""

from __future__ import annotations

import json

from iclip.platform.transcript.wire import GenerationChanged, GenerationChangedPayload


def test_a_generation_frame_omits_empty_origin_fields_on_the_wire() -> None:
    frame = GenerationChanged(
        session_id=None,
        payload=GenerationChangedPayload(id="job-1", kind="video", status="pending"),
    )

    sent = json.loads(frame.model_dump_json(exclude_none=True, by_alias=True))

    assert sent == {
        "type": "event.generation.changed",
        "payload": {"id": "job-1", "kind": "video", "status": "pending"},
    }


def test_a_generation_frame_keeps_its_origin_when_known() -> None:
    frame = GenerationChanged(
        session_id="c-1",
        payload=GenerationChangedPayload(
            id="job-2", kind="image", status="completed", shot_index=1, frame_number=3
        ),
    )

    sent = json.loads(frame.model_dump_json(exclude_none=True, by_alias=True))

    assert sent["session_id"] == "c-1"
    assert sent["payload"] == {
        "id": "job-2",
        "kind": "image",
        "status": "completed",
        "shot_index": 1,
        "frame_number": 3,
    }
