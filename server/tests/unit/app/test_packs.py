"""业务能力包按名字解析，名字没登记即装配期报错。"""

from __future__ import annotations

import pytest
from pydantic_ai.capabilities import Capability

from iclip.app import packs
from iclip.harness.agents import AgentCapabilities


@pytest.fixture
def registered(monkeypatch: pytest.MonkeyPatch) -> Capability[object]:
    """临时登记一个能力包（表本身是模块级常量，用 monkeypatch 保证测完还原）。"""

    pack = Capability[object](id="video", instructions="按镜头表干活。")

    def factory() -> AgentCapabilities:
        return (pack,)

    monkeypatch.setattr(packs, "PACKS", {"video": factory})
    return pack


def test_unknown_pack_name_fails_loudly() -> None:
    """名字打错不能静默变成「没挂能力」——那样 agent 会带着半套工具上线。"""

    with pytest.raises(RuntimeError, match="引用了未登记的能力包 'video'"):
        packs.resolve_packs(("video",), declared_by="agent storyboard")


def test_registered_pack_resolves_to_its_capabilities(registered: Capability[object]) -> None:
    assert packs.resolve_packs(("video",), declared_by="agent storyboard") == (registered,)


def test_no_packs_declared_mounts_nothing() -> None:
    assert packs.resolve_packs((), declared_by="agent storyboard") == ()
