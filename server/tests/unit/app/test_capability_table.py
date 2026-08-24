"""capability 按名字解析，名字没登记即装配期报错。"""

from __future__ import annotations

import pytest
from pydantic_ai.capabilities import Capability

from iclip.app.capability_table import (
    CapabilityTable,
    build_capability_table,
    resolve_capabilities,
)
from iclip.capabilities.workspace.capability import Workspace
from tests.helpers.workspace import FakeWorkspaceStore


@pytest.fixture
def video() -> Capability[object]:
    return Capability[object](id="video", instructions="按镜头表干活。")


@pytest.fixture
def table(video: Capability[object]) -> CapabilityTable:
    return {"video": (video,)}


def test_unknown_name_fails_loudly(table: CapabilityTable) -> None:
    """名字打错不能静默变成「没挂」——那样 agent 会带着半套工具上线。"""

    with pytest.raises(RuntimeError, match="引用了未登记的 capability 'shots'"):
        resolve_capabilities(("shots",), table=table, declared_by="agent storyboard")


def test_registered_name_resolves(video: Capability[object], table: CapabilityTable) -> None:
    assert resolve_capabilities(("video",), table=table, declared_by="agent storyboard") == (video,)


def test_nothing_declared_mounts_nothing(table: CapabilityTable) -> None:
    assert resolve_capabilities((), table=table, declared_by="agent storyboard") == ()


def test_workspace_is_registered_under_its_declaration_name() -> None:
    """``agents.yaml`` 里写 capabilities: [workspace] 得真能装出工作区来。"""

    built = build_capability_table(workspace_store=FakeWorkspaceStore())
    resolved = resolve_capabilities(("workspace",), table=built, declared_by="agent storyboard")
    assert [type(capability) for capability in resolved] == [Workspace]
