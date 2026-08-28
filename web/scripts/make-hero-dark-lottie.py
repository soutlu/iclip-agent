#!/usr/bin/env python3
"""由 public/lottie/home-hero-light.json 生成深色配色的 home-hero-dark.json。

Lottie 的颜色烤在图形里，取不到 CSS 变量，深色只能是另一份产物。想调深色配色就改
下面 darken() 的映射再重跑，别手改 dark.json——它是生成物。

    python3 scripts/make-hero-dark-lottie.py
"""

import json
import math
import pathlib

LOTTIE_DIR = pathlib.Path(__file__).resolve().parent.parent / "public" / "lottie"


def _to_linear(channel: float) -> float:
    return channel / 12.92 if channel <= 0.04045 else ((channel + 0.055) / 1.055) ** 2.4


def _to_gamma(channel: float) -> float:
    return 12.92 * channel if channel <= 0.0031308 else 1.055 * channel ** (1 / 2.4) - 0.055


def to_oklch(r: float, g: float, b: float) -> tuple[float, float, float]:
    r, g, b = _to_linear(r), _to_linear(g), _to_linear(b)
    l = (0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b) ** (1 / 3)
    m = (0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b) ** (1 / 3)
    s = (0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b) ** (1 / 3)
    lightness = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s
    a = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s
    b2 = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s
    return lightness, math.hypot(a, b2), math.degrees(math.atan2(b2, a)) % 360


def to_rgb(lightness: float, chroma: float, hue: float) -> tuple[float, ...]:
    a = chroma * math.cos(math.radians(hue))
    b2 = chroma * math.sin(math.radians(hue))
    l = (lightness + 0.3963377774 * a + 0.2158037573 * b2) ** 3
    m = (lightness - 0.1055613458 * a - 0.0638541728 * b2) ** 3
    s = (lightness - 0.0894841775 * a - 1.2914855480 * b2) ** 3
    r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
    g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
    b = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
    return tuple(min(1.0, max(0.0, _to_gamma(channel))) for channel in (r, g, b))


def darken(rgb: tuple[float, float, float]) -> tuple[float, ...]:
    """按色相分族：结构色翻明度，身份色只微调。

    翻转的落点定成「原来的纯白落回页面深色底、最深的墨色升到 0.84」，纯白才不会
    变成一块黑洞。绿与肤色翻了就不是绿和肤色了，所以只按暗底需要提一点或压一点。
    """
    lightness, chroma, hue = to_oklch(*rgb)
    if chroma < 0.02 or 200 <= hue <= 280:  # 背景板、深蓝墨色、纯白高光、近黑细节
        return to_rgb(0.98 - 0.76 * lightness, chroma * 0.85, hue)
    if 120 <= hue < 200:  # 绿：上衣与胶片格
        return to_rgb(min(0.94, lightness + 0.03), chroma, hue)
    return to_rgb(max(0.06, lightness - 0.05), chroma * 0.92, hue)  # 暖色：肤色


def recolor(node: object) -> None:
    if isinstance(node, dict):
        if node.get("ty") in ("fl", "st") and node.get("c", {}).get("a") == 0:
            channels = node["c"]["k"]
            node["c"]["k"] = [round(v, 4) for v in darken(tuple(channels[:3]))] + list(
                channels[3:]
            )
        for value in node.values():
            recolor(value)
    elif isinstance(node, list):
        for value in node:
            recolor(value)


def main() -> None:
    light = json.loads((LOTTIE_DIR / "home-hero-light.json").read_text())
    recolor(light)
    (LOTTIE_DIR / "home-hero-dark.json").write_text(json.dumps(light, separators=(",", ":")))
    print("已写出 home-hero-dark.json")


if __name__ == "__main__":
    main()
