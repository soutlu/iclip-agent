"""Export the vector Rive scene as an SVG with the same two endpoint poses.

The scene remains the source for layout, draw order, geometry, colors and
animation poses. This export needs only Python's standard library.
"""
from __future__ import annotations

import argparse
import math
from pathlib import Path
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent
PROPERTIES = {"13": "x", "14": "y", "15": "rotation", "16": "scaleX",
              "17": "scaleY", "18": "opacity"}
DEFAULTS = {"x": 0.0, "y": 0.0, "rotation": 0.0, "scaleX": 1.0,
            "scaleY": 1.0, "opacity": 1.0}
VISIBLE = {"Node", "Shape"}


def number(value: float) -> str:
    value = round(value, 3)
    return "0" if abs(value) < 0.0005 else f"{value:.3f}".rstrip("0").rstrip(".")


def value(element: ET.Element, name: str, default: float = 0.0) -> float:
    return float(element.get(name, str(default)))


def point(vertex: ET.Element) -> tuple[float, float]:
    return value(vertex, "x"), value(vertex, "y")


def coordinates(pt: tuple[float, float]) -> str:
    return f"{number(pt[0])} {number(pt[1])}"


def handle(vertex: ET.Element, side: str) -> tuple[float, float]:
    x, y = point(vertex)
    angle, distance = value(vertex, side + "Rotation"), value(vertex, side + "Distance")
    return x + math.cos(angle) * distance, y + math.sin(angle) * distance


def polygon(vertices: list[ET.Element]) -> str:
    """Retain the small rounded corners on the original package geometry."""
    corners = []
    for i, vertex in enumerate(vertices):
        p, before, after = point(vertex), point(vertices[i - 1]), point(vertices[(i + 1) % len(vertices)])
        length_in, length_out = math.dist(p, before), math.dist(p, after)
        radius = value(vertex, "radius")
        if not radius or min(length_in, length_out) < 0.001:
            corners.append((p, p, p))
            continue
        a = ((before[0] - p[0]) / length_in, (before[1] - p[1]) / length_in)
        b = ((after[0] - p[0]) / length_out, (after[1] - p[1]) / length_out)
        theta = math.acos(max(-1, min(1, a[0] * b[0] + a[1] * b[1])))
        distance = min(radius / max(0.001, math.tan(theta / 2)), length_in / 2, length_out / 2)
        corners.append(((p[0] + a[0] * distance, p[1] + a[1] * distance), p,
                        (p[0] + b[0] * distance, p[1] + b[1] * distance)))
    out = ["M" + coordinates(corners[0][0])]
    for i, (start, p, end) in enumerate(corners):
        if i:
            out.append("L" + coordinates(start))
        if start != end:
            out.append("Q" + coordinates(p) + " " + coordinates(end))
    return "".join(out) + "Z"


def path_data(path: ET.Element) -> str:
    vertices = list(path)
    if not vertices:
        raise ValueError("Empty path")
    if not all(v.tag in {"StraightVertex", "CubicDetachedVertex"} for v in vertices):
        raise ValueError("Unsupported Rive vertex type")
    closed = path.get("isClosed", "false") == "true"
    if closed and all(v.tag == "StraightVertex" for v in vertices):
        return polygon(vertices)
    result = ["M" + coordinates(point(vertices[0]))]
    pairs = list(zip(vertices, vertices[1:]))
    if closed:
        pairs.append((vertices[-1], vertices[0]))
    for start, end in pairs:
        if value(start, "outDistance") or value(end, "inDistance"):
            result.append("C" + coordinates(handle(start, "out")) + " " +
                          coordinates(handle(end, "in")) + " " + coordinates(point(end)))
        else:
            result.append("L" + coordinates(point(end)))
    if closed:
        result.append("Z")
    return "".join(result)


def color(argb: str) -> tuple[str, float]:
    if len(argb) != 8:
        raise ValueError(f"Expected ARGB color, got {argb!r}")
    return "#" + argb[2:].lower(), int(argb[:2], 16) / 255


def pose(node: ET.Element, overrides: dict[str, float] | None = None) -> dict[str, float]:
    result = {key: value(node, key, default) for key, default in DEFAULTS.items()}
    result.update(overrides or {})
    return result


def transform(properties: dict[str, float]) -> str:
    return (f"translate({number(properties['x'])} {number(properties['y'])}) "
            f"rotate({number(math.degrees(properties['rotation']))}) "
            f"scale({number(properties['scaleX'])} {number(properties['scaleY'])})")


def pose_string(properties: dict[str, float]) -> str:
    return ",".join(number(properties[key]) for key in DEFAULTS)


def endpoints(artboard: ET.Element, name: str) -> dict[str, dict[str, float]]:
    animation = artboard.find(f"LinearAnimation[@name='{name}']")
    if animation is None:
        raise ValueError(f"Missing {name} animation")
    result = {}
    for obj in animation.findall("KeyedObject"):
        values = {}
        for prop in obj.findall("KeyedProperty"):
            frames = prop.findall("KeyFrameDouble")
            if len(frames) != 1 or frames[0].get("frame") != "0":
                raise ValueError(f"{name} must be a single endpoint pose")
            values[PROPERTIES[prop.attrib["propertyKey"]]] = value(frames[0], "value")
        result[obj.attrib["objectId"]] = values
    return result


class Export:
    def __init__(self, scene: ET.Element, expanded: bool):
        if any(e.tag in {"Image", "ImageAsset", "Text", "FontAsset", "ScriptAsset"} for e in scene.iter()):
            raise ValueError("The SVG source must already be entirely vector geometry")
        self.artboard = scene.find("Artboard")
        if self.artboard is None:
            raise ValueError("Artboard missing")
        self.closed = endpoints(self.artboard, "Fold")
        self.open = endpoints(self.artboard, "Reveal")
        if self.closed.keys() != self.open.keys():
            raise ValueError("Open and closed poses have different animated nodes")
        self.expanded = expanded
        self.gradient_count = 0
        self.svg = ET.Element("svg", {
            "xmlns": "http://www.w3.org/2000/svg", "viewBox": "0 0 1200 600",
            "width": "1200", "height": "600", "class": "cue-mascot",
            "role": "img", "aria-label": "Cue 与 mmt 鞋盒、鞋履及服装",
            "data-expanded": str(expanded).lower(), "color": "#171818",
        })
        self.defs = ET.SubElement(self.svg, "defs")

    def paint(self, fill: ET.Element) -> dict[str, str]:
        result = {"fill-rule": "evenodd" if fill.get("fillRule") == "evenOdd" else "nonzero"}
        solid = fill.find("SolidColor")
        if solid is not None:
            rgb, alpha = color(solid.attrib["colorValue"])
            bound = solid.find("DataBindContext[@propertyKey='37']")
            result["fill"] = "currentColor" if bound is not None else rgb
            if alpha < 1:
                result["fill-opacity"] = number(alpha)
            return result
        gradient = fill.find("LinearGradient")
        if gradient is None:
            raise ValueError("Unsupported fill")
        self.gradient_count += 1
        gradient_id = f"cue-gradient-{self.gradient_count}"
        svg_gradient = ET.SubElement(self.defs, "linearGradient", {
            "id": gradient_id, "gradientUnits": "userSpaceOnUse",
            "x1": number(value(gradient, "startX")), "y1": number(value(gradient, "startY")),
            "x2": number(value(gradient, "endX")), "y2": number(value(gradient, "endY")),
        })
        for stop in gradient.findall("GradientStop"):
            rgb, alpha = color(stop.attrib["colorValue"])
            attrs = {"offset": number(value(stop, "position")), "stop-color": rgb}
            if alpha < 1:
                attrs["stop-opacity"] = number(alpha)
            ET.SubElement(svg_gradient, "stop", attrs)
        result["fill"] = f"url(#{gradient_id})"
        return result

    def node(self, source: ET.Element, parent: ET.Element):
        closed = pose(source, self.closed.get(source.get("id", "")))
        attrs = {"transform": transform(closed)}
        if closed["opacity"] != 1:
            attrs["opacity"] = number(closed["opacity"])
        if source.get("id") in self.closed:
            opened = pose(source, self.open[source.attrib["id"]])
            attrs.update({"data-cue-node": source.attrib["id"],
                          "data-from": pose_string(closed), "data-to": pose_string(opened)})
            if self.expanded:
                attrs["transform"] = transform(opened)
                attrs["opacity"] = number(opened["opacity"])
        target = ET.SubElement(parent, "g", attrs)
        if source.tag == "Shape":
            fills = source.findall("Fill")
            if len(fills) != 1:
                raise ValueError("Expected one fill per Shape")
            paint = self.paint(fills[0])
            paths = source.findall("PointsPath")
            if paths:
                ET.SubElement(target, "path", {"d": "".join(path_data(p) for p in paths), **paint})
            for rect in source.findall("Rectangle"):
                w, h = value(rect, "width"), value(rect, "height")
                ET.SubElement(target, "rect", {"x": number(-w / 2), "y": number(-h / 2),
                              "width": number(w), "height": number(h),
                              "rx": number(value(rect, "cornerRadiusTL")), **paint})
            for ellipse in source.findall("Ellipse"):
                ET.SubElement(target, "ellipse", {"rx": number(value(ellipse, "width") / 2),
                              "ry": number(value(ellipse, "height") / 2), **paint})
        for child in reversed(list(source)):
            if child.tag in VISIBLE:
                self.node(child, target)

    def build(self) -> bytes:
        # Rive paints the first sibling on top; SVG paints the last on top.
        for child in reversed(list(self.artboard)):
            if child.tag in VISIBLE:
                self.node(child, self.svg)
        return ET.tostring(self.svg, encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scene", type=Path, default=ROOT / "animation/scene.rml")
    parser.add_argument("--expanded", action="store_true")
    parser.add_argument("--output", type=Path, default=ROOT / "cue-mmt.svg")
    args = parser.parse_args()
    data = Export(ET.parse(args.scene).getroot(), args.expanded).build()
    args.output.write_bytes(data)
    print(f"{args.output}: {len(data):,} bytes")
    template = ROOT / "index.template.html"
    if args.output == ROOT / "cue-mmt.svg" and template.exists():
        inline = data.decode().replace('role="img"', 'aria-hidden="true"')
        (ROOT / "index.html").write_text(template.read_text().replace("{{CUE_SVG}}", inline))


if __name__ == "__main__":
    main()
