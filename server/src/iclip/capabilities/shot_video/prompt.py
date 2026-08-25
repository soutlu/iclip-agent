"""整版 prompt 的四段式拼接。纯拼接、零模型调用。

逐格 visual_prompt 与「全局参考设定」都由调用方撰写后经工具入参传进来。
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


__all__ = [
    "FILLER_CELL_PROMPT",
    "GRID_CELLS",
    "GRID_COLS",
    "GRID_ROWS",
    "assemble_grid_prompt",
]
