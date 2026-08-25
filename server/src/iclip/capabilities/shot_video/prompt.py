"""整版 prompt 的分段拼接。纯拼接、零模型调用。

两版：镜头帧那版带「全局参考设定」，各格属于同一场戏；补拍参考图那版没有参考图，
各格是彼此无关的实体设定图。逐格文字都由调用方撰写后经工具入参传进来。
"""

from __future__ import annotations

from collections.abc import Sequence

GRID_ROWS = 2
GRID_COLS = 2
GRID_CELLS = GRID_ROWS * GRID_COLS

FILLER_CELL_PROMPT = "纯中性灰空面板"
"""补满网格用的空格。切格后由调用方丢弃——出图只认完整网格。"""


def assemble_grid_prompt(
    *, global_reference: str, visual_prompts: Sequence[str], target_aspect: str
) -> str:
    """拼一版整版 prompt。

    ``global_reference`` 原样进第一段，里面的 ``@ImageN`` 序号必须和提交时参考图
    列表的顺序一致。
    """

    if not 1 <= len(visual_prompts) <= GRID_CELLS:
        raise ValueError(f"visual_prompts 必须是 1-{GRID_CELLS} 条")
    if not global_reference.strip():
        raise ValueError("global_reference 不能为空")
    padded = [*visual_prompts, *[FILLER_CELL_PROMPT] * (GRID_CELLS - len(visual_prompts))]

    storyboard = ["storyboard:"]
    for index, prompt in enumerate(padded, start=1):
        storyboard.append(f"  - frame_id: {index}")
        storyboard.append(f'    visual_prompt: "{prompt}"')

    return "\n".join(
        [
            "1. 全局参考设定",
            global_reference.strip(),
            "",
            "2. Core Command",
            f"A clean {GRID_ROWS}x{GRID_COLS} storyboard grid with four equal panels "
            f"on {target_aspect} aspect ratio.",
            "",
            "3. Storyboard Details",
            "\n".join(storyboard),
            "",
            "4. Mandatory Suffix",
            f"Aspect Ratio: {target_aspect}",
            f"OUTPUT: A clean {GRID_ROWS}x{GRID_COLS} grid with no borders, no text, "
            "no captions and no watermarks.",
        ]
    )


def assemble_anchor_prompt(*, cells: Sequence[str], target_aspect: str) -> str:
    """拼一版补拍参考图的整版 prompt。

    没有「全局参考设定」段：补拍不带参考图，每格的文字就是该实体外观的全部依据。
    整版明说各格彼此无关，否则模型会把四格当成一场戏、给它们编出统一的光线与背景。
    """

    if not 1 <= len(cells) <= GRID_CELLS:
        raise ValueError(f"cells 必须是 1-{GRID_CELLS} 条")
    padded = [*cells, *[FILLER_CELL_PROMPT] * (GRID_CELLS - len(cells))]

    panels = ["panels:"]
    for index, cell in enumerate(padded, start=1):
        panels.append(f"  - panel_id: {index}")
        panels.append(f'    description: "{cell}"')

    return "\n".join(
        [
            "1. Core Command",
            f"A clean {GRID_ROWS}x{GRID_COLS} reference sheet with four equal panels "
            f"on {target_aspect} aspect ratio. Each panel is an independent reference "
            "plate; the panels share no scene, no story and no continuity.",
            "",
            "2. Panel Details",
            "\n".join(panels),
            "",
            "3. Mandatory Suffix",
            f"Aspect Ratio: {target_aspect}",
            f"OUTPUT: A clean {GRID_ROWS}x{GRID_COLS} grid with no borders, no text, "
            "no captions and no watermarks.",
        ]
    )


__all__ = [
    "FILLER_CELL_PROMPT",
    "GRID_CELLS",
    "GRID_COLS",
    "GRID_ROWS",
    "assemble_anchor_prompt",
    "assemble_grid_prompt",
]
