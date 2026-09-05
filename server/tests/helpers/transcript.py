"""transcript 测试替身、两条路的归一化比对与金样。"""

from __future__ import annotations

import difflib
import json
import os
import re
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from pydantic import BaseModel
from pydantic_ai_harness.step_persistence import ContinuableSnapshot, InMemoryStepStore

from iclip.harness.transcript.from_messages import SteeredPrompt
from iclip.harness.transcript.history import TranscriptHistory
from iclip.harness.transcript.service import TranscriptService
from iclip.harness.transcript.store import TranscriptStore
from iclip.harness.transcript.subscription import subscribe_frames
from iclip.platform.transcript.display import ToolDisplayRegistry
from iclip.platform.transcript.ops import MAIN_AGENT_ID
from iclip.platform.transcript.wire import TranscriptPage

GOLDEN_DIR = Path(__file__).resolve().parents[3] / "contract" / "transcript"
"""金样放在跨端合同目录，前端测试读同一份。"""


class InMemoryConversationSnapshots(InMemoryStepStore):
    """官方内存 store 加一个按对话取快照的入口，口径与 PgStepStore 一致。"""

    def __init__(self) -> None:
        super().__init__()
        self._by_conversation: list[ContinuableSnapshot] = []

    async def save_snapshot(self, snapshot: ContinuableSnapshot) -> None:
        await super().save_snapshot(snapshot)
        self._by_conversation.append(snapshot)

    async def latest_conversation_snapshot(
        self, *, conversation_id: str, include_interrupted: bool = False
    ) -> ContinuableSnapshot | None:
        found = [
            item
            for item in self._by_conversation
            if item.conversation_id == conversation_id
            and (include_interrupted or item.state == "complete")
        ]
        return found[-1] if found else None


class NoPromptRuns:
    """没有 prompt 映射的历史读取：每个 run 各自成轮。"""

    async def prompt_of_runs(self, conversation_id: str) -> dict[str, str]:
        return {}

    async def prompt_status_of_runs(self, conversation_id: str) -> dict[str, str]:
        return {}

    async def steered_prompts(self, conversation_id: str) -> tuple[SteeredPrompt, ...]:
        return ()


# --- 归一化 -----------------------------------------------------------------

_TIMESTAMP = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}")
_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
_SHORT_ID = re.compile(r"^(?:[a-z_]+-[0-9a-f]{8}|prm_[0-9a-f]{8,})$")
"""runner 铸的 run id（storyboard-1a2b3c4d）、测试铸的会话 id（c-…）与 prompt id。"""


class Normalizer:
    """把时间与随机 id 换成占位，同一个原值全程换成同一个占位。"""

    def __init__(self) -> None:
        self._ids: dict[str, str] = {}

    def __call__(self, value: Any) -> Any:
        if isinstance(value, BaseModel):
            return self(value.model_dump(by_alias=True, exclude_none=True))
        if isinstance(value, dict):
            return {key: self._field(key, item) for key, item in value.items()}
        if isinstance(value, list | tuple):
            return [self(item) for item in value]
        if isinstance(value, str):
            return self._scalar(value)
        return value

    def _field(self, key: str, value: Any) -> Any:
        if key == "durationMs":
            # 两条路的时钟不同，耗时对不上；金样要能过前端的 number schema，所以写 0 不写占位串。
            return 0
        return self(value)

    def _scalar(self, value: str) -> str:
        if _TIMESTAMP.match(value):
            return "<ts>"
        if _UUID.match(value) or _SHORT_ID.match(value):
            return self._ids.setdefault(value, f"<id-{len(self._ids) + 1}>")
        return value


def normalize(value: Any) -> Any:
    return Normalizer()(value)


def comparable(page: TranscriptPage) -> dict[str, Any]:
    """两条路能比的那部分：seq 是店的水位、prompts 只有实时店有，meta 只比 activity。

    失败或取消的轮不比用量：官方在这两种收尾里不发结果事件，实时侧填不上用量，刷新后才有。
    这是已知差异，不是两条路的结构分叉。
    """

    data = page.model_dump(by_alias=True, exclude_none=True)
    data.pop("seq", None)
    data.pop("prompts", None)
    meta = data.get("meta", {})
    data["meta"] = {"activity": meta.get("activity")}
    for turn in data.get("items", ()):
        if turn.get("kind") == "turn" and turn.get("state") in {"failed", "cancelled"}:
            turn.pop("usage", None)
            for step in turn.get("steps", ()):
                step.pop("usage", None)
    return normalize(data)


# --- 两条路 -----------------------------------------------------------------


def _service(
    store: TranscriptStore, history: TranscriptHistory, queue: Any, runner: Any
) -> TranscriptService:
    async def records_nothing(*_args: Any) -> None:
        return None

    return TranscriptService(
        store=store,
        history=history,
        queue=queue,
        runner=runner,
        context_limits={},
        record_materials=records_nothing,
    )


async def live_page(
    store: TranscriptStore,
    conversation_id: str,
    agent_id: str,
    *,
    queue: Any,
    runner: Any,
    display: ToolDisplayRegistry,
    runtime_agent_id: str,
) -> TranscriptPage:
    """客户端实时收到的东西：把补发日志重放进一个新店，用空历史读出一页。

    读子代理那页时主流也一起重放：子页的名册取自主流的任务表。
    """

    replayed = TranscriptStore()
    for replayed_agent in dict.fromkeys((MAIN_AGENT_ID, agent_id)):
        for batch in store.subscribe_view(conversation_id, replayed_agent, since=0).batches:
            replayed.append(conversation_id, replayed_agent, batch.ops)
    history = TranscriptHistory(InMemoryConversationSnapshots(), NoPromptRuns(), display)
    return await _service(replayed, history, queue, runner).page(
        conversation_id, agent_id=agent_id, runtime_agent_id=runtime_agent_id
    )


async def cold_page(
    step_store: Any,
    conversation_id: str,
    agent_id: str,
    *,
    queue: Any,
    runner: Any,
    display: ToolDisplayRegistry,
    runtime_agent_id: str,
    delegate_tool: str | None,
) -> TranscriptPage:
    """刷新后看到的东西：空的实时店，全靠持久化重建。"""

    history = TranscriptHistory(step_store, queue, display, delegate_tool)
    return await _service(TranscriptStore(), history, queue, runner).page(
        conversation_id, agent_id=agent_id, runtime_agent_id=runtime_agent_id
    )


def ws_frames(
    store: TranscriptStore, conversation_id: str, agent_id: str = MAIN_AGENT_ID
) -> list[Any]:
    """这条流从订阅起会收到的全部帧：一帧 reset，之后每批一帧 ops。"""

    view = store.subscribe_view(conversation_id, agent_id, since=0)
    frames: list[Any] = [
        {"type": "transcript.reset", "payload": frame.model_dump(by_alias=True, exclude_none=True)}
        for frame in subscribe_frames(view, agent_id=agent_id, since=None)
    ]
    for batch in view.batches:
        frames.append(
            {
                "type": "transcript.ops",
                "payload": {
                    "agent_id": agent_id,
                    "seq": batch.seq,
                    "ops": [op.model_dump(by_alias=True, exclude_none=True) for op in batch.ops],
                },
            }
        )
    return frames


# --- 金样 -------------------------------------------------------------------


def check_golden(name: str, sample: Any) -> None:
    """与 contract/transcript/<name>.json 比对；UPDATE_GOLDEN=1 时改写文件。"""

    path = GOLDEN_DIR / f"{name}.json"
    rendered = json.dumps(sample, ensure_ascii=False, indent=2, sort_keys=False) + "\n"
    if os.environ.get("UPDATE_GOLDEN") == "1":
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(rendered, encoding="utf-8")
        return
    expected = path.read_text(encoding="utf-8")
    if expected != rendered:
        diff = "".join(
            difflib.unified_diff(
                expected.splitlines(keepends=True),
                rendered.splitlines(keepends=True),
                fromfile=str(path),
                tofile="现在跑出来的",
            )
        )
        raise AssertionError(f"金样 {name} 变了，确认是有意为之再用 UPDATE_GOLDEN=1 更新：\n{diff}")


def frames_of(page: TranscriptPage, turn_id: str, step_id: str) -> Sequence[Any]:
    for turn in page.items:
        if turn.turn_id != turn_id:
            continue
        for step in turn.steps:
            if step.step_id == step_id:
                return step.frames
    raise AssertionError(f"没有 {step_id}")


__all__ = [
    "GOLDEN_DIR",
    "InMemoryConversationSnapshots",
    "NoPromptRuns",
    "Normalizer",
    "check_golden",
    "cold_page",
    "comparable",
    "frames_of",
    "live_page",
    "normalize",
    "ws_frames",
]
