"""Embed the five hand-authored SVG assets as native Rive geometry.

The approved scene and outlined Cue wordmark are frozen in layout.xml. This
builder only fills the five static artwork slots; it does not author motion.
Solid fills and userSpaceOnUse linear gradients retain SVG alpha semantics.
Run with Python 3, then compile this directory with `rive . --once`.
"""
from __future__ import annotations

from collections import Counter
from pathlib import Path
import hashlib
import json
import math
import re
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent
SVG_ROOT = ROOT.parent / "assets/svg"
SLOTS = {
    "sneaker": "0:149",
    "slide": "0:153",
    "kids": "0:157",
    "heel": "0:161",
    "top": "0:165",
}
NUMBER = r"[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?"
TOKEN = re.compile(rf"{NUMBER}|[A-Za-z]")


def number(value: float) -> str:
    return "0" if abs(value) < 1e-14 else format(value, ".12g")


def add(parent: ET.Element, tag: str, **attrs) -> ET.Element:
    def encode(value):
        if isinstance(value, bool):
            return str(value).lower()
        if isinstance(value, float):
            return number(value)
        return str(value)

    return ET.SubElement(parent, tag, {k: encode(v) for k, v in attrs.items()})


class Contours:
    """Keep cubic control points until they are encoded as Rive handles."""

    def __init__(self):
        self.paths = []
        self.vertices = []

    def move(self, point):
        if self.vertices:
            raise ValueError("A filled contour must close before the next move")
        self.vertices = [{"point": tuple(point), "incoming": None, "outgoing": None}]

    def line(self, point):
        if not self.vertices:
            raise ValueError("Line has no current contour")
        self.vertices.append({"point": tuple(point), "incoming": None, "outgoing": None})

    def cubic(self, control1, control2, point):
        if not self.vertices:
            raise ValueError("Curve has no current contour")
        self.vertices[-1]["outgoing"] = tuple(control1)
        self.vertices.append({
            "point": tuple(point), "incoming": tuple(control2), "outgoing": None,
        })

    def close(self):
        if not self.vertices:
            raise ValueError("Close has no current contour")
        # SVG often writes its last curve back to the first point. Rive encodes
        # that closing curve with the first vertex's incoming handle.
        if len(self.vertices) > 2 and math.dist(
            self.vertices[0]["point"], self.vertices[-1]["point"]
        ) < 1e-9:
            self.vertices[0]["incoming"] = self.vertices[-1]["incoming"]
            self.vertices.pop()
        if len(self.vertices) > 1:
            self.paths.append(self.vertices)
        self.vertices = []

    def append_rml(self, shape: ET.Element, name: str):
        for index, vertices in enumerate(self.paths, 1):
            path = add(shape, "PointsPath", name=f"{name} contour {index}", isClosed=True)
            for vertex in vertices:
                x, y = vertex["point"]
                if vertex["incoming"] is None and vertex["outgoing"] is None:
                    add(path, "StraightVertex", x=float(x), y=float(y))
                    continue
                attrs = {"x": float(x), "y": float(y)}
                for field, prefix in (("incoming", "in"), ("outgoing", "out")):
                    control = vertex[field]
                    if control is not None:
                        dx, dy = control[0] - x, control[1] - y
                        if math.hypot(dx, dy) > 1e-14:
                            attrs[prefix + "Rotation"] = math.atan2(dy, dx)
                            attrs[prefix + "Distance"] = math.hypot(dx, dy)
                add(path, "CubicDetachedVertex", **attrs)


def parse_path(data: str) -> Contours:
    """Read the M/L/C/Z subset used by the supplied hand-authored SVG assets."""
    if TOKEN.sub("", data).replace(",", "").strip():
        raise ValueError("Unexpected SVG path data")
    tokens = TOKEN.findall(data)
    path = Contours()
    cursor = (0.0, 0.0)
    start = cursor
    command = None
    index = 0
    while index < len(tokens):
        if tokens[index].isalpha():
            command = tokens[index]
            index += 1
            if command in "Zz":
                path.close()
                cursor = start
                command = None
                continue
        if command is None or command.upper() not in {"M", "L", "C"}:
            raise ValueError(f"Unsupported SVG path command {command!r}")
        count = 6 if command.upper() == "C" else 2
        if index + count > len(tokens):
            raise ValueError("Incomplete SVG path command")
        values = [float(v) for v in tokens[index:index + count]]
        index += count
        points = list(zip(values[::2], values[1::2]))
        if command.islower():
            points = [(x + cursor[0], y + cursor[1]) for x, y in points]
        if command.upper() == "M":
            path.move(points[0])
            start = points[0]
            command = "l" if command.islower() else "L"
        elif command.upper() == "L":
            path.line(points[0])
        else:
            path.cubic(*points)
        cursor = points[-1]
    if path.vertices:
        raise ValueError("SVG artwork contains an unclosed contour")
    return path


def structural_value(element: ET.Element):
    return [element.tag, sorted(element.attrib.items()),
            [structural_value(child) for child in element]]


def motion_digest(scene: ET.Element) -> str:
    motion = [structural_value(e) for e in scene.iter()
              if e.tag in {"LinearAnimation", "StateMachine", "ViewModel"}]
    return hashlib.sha256(json.dumps(motion, separators=(",", ":")).encode()).hexdigest()


def svg_tag(element: ET.Element) -> str:
    return element.tag.rsplit("}", 1)[-1]


def finite_number(value: str, label: str) -> float:
    if not re.fullmatch(NUMBER, value):
        raise ValueError(f"{label}: expected a unitless numeric value")
    result = float(value)
    if not math.isfinite(result):
        raise ValueError(f"{label}: value must be finite")
    return result


def unit_interval(value: str, label: str) -> float:
    result = finite_number(value, label)
    if not 0 <= result <= 1:
        raise ValueError(f"{label}: expected a value between 0 and 1")
    return result


def argb(color: str, opacity: float) -> str:
    if not re.fullmatch(r"#[0-9a-fA-F]{6}", color):
        raise ValueError(f"Expected #RRGGBB color, received {color!r}")
    alpha = int(opacity * 255 + 0.5)
    return f"{alpha:02X}" + color[1:].upper()


def read_svg(svg: ET.Element, slug: str):
    """Separate paint definitions from drawable paths without changing order."""
    paths = []
    gradients = {}
    for element in svg:
        if svg_tag(element) == "path":
            paths.append(element)
            continue
        if svg_tag(element) != "defs":
            raise ValueError(f"{slug}: only paths and linear-gradient definitions are accepted")
        for gradient in element:
            if svg_tag(gradient) != "linearGradient":
                raise ValueError(f"{slug}: only linear gradients are accepted in defs")
            required = {"id", "gradientUnits", "x1", "y1", "x2", "y2"}
            if set(gradient.attrib) != required:
                raise ValueError(f"{slug}: linear gradient must declare id, units and four coordinates")
            gradient_id = gradient.attrib["id"]
            if not gradient_id or gradient_id in gradients:
                raise ValueError(f"{slug}: empty or duplicate gradient id")
            if gradient.attrib["gradientUnits"] != "userSpaceOnUse":
                raise ValueError(f"{slug}: gradient coordinates must use the original SVG canvas")
            coordinates = {target: finite_number(gradient.attrib[source], f"{slug} {gradient_id} {source}")
                           for source, target in (("x1", "startX"), ("y1", "startY"),
                                                  ("x2", "endX"), ("y2", "endY"))}
            stops = []
            previous_offset = -1.0
            for stop in gradient:
                if svg_tag(stop) != "stop" or set(stop.attrib) - {
                    "offset", "stop-color", "stop-opacity",
                }:
                    raise ValueError(f"{slug}: unexpected linear-gradient stop")
                offset = unit_interval(stop.attrib["offset"], f"{slug} gradient stop offset")
                if offset < previous_offset:
                    raise ValueError(f"{slug}: gradient stop offsets must be in ascending order")
                previous_offset = offset
                color = stop.attrib["stop-color"]
                opacity = unit_interval(stop.attrib.get("stop-opacity", "1"), f"{slug} stop-opacity")
                argb(color, opacity)
                stops.append((offset, color, opacity))
            if len(stops) < 2:
                raise ValueError(f"{slug}: a linear gradient needs at least two stops")
            gradients[gradient_id] = {"coordinates": coordinates, "stops": stops}
    if not paths:
        raise ValueError(f"{slug}: no drawable paths")
    return paths, gradients


def append_svg_fill(shape: ET.Element, element: ET.Element, gradients: dict, slug: str):
    fill_rule = element.attrib.get("fill-rule", "nonzero")
    if fill_rule not in {"nonzero", "evenodd"}:
        raise ValueError(f"{slug}: unsupported fill rule")
    fill = add(shape, "Fill", name="Fill", fillRule={
        "nonzero": "nonZero", "evenodd": "evenOdd",
    }[fill_rule])
    opacity = unit_interval(element.attrib.get("fill-opacity", "1"), f"{slug} fill-opacity")
    color = element.attrib.get("fill", "")
    reference = re.fullmatch(r"url\(#([^\s)]+)\)", color)
    if reference is None:
        add(fill, "SolidColor", colorValue=argb(color, opacity), name="Color")
        return
    gradient_id = reference.group(1)
    if gradient_id not in gradients:
        raise ValueError(f"{slug}: missing gradient {gradient_id!r}")
    definition = gradients[gradient_id]
    gradient = add(fill, "LinearGradient", name=gradient_id, **definition["coordinates"])
    for offset, stop_color, stop_opacity in definition["stops"]:
        # SVG fill-opacity multiplies every stop's alpha; motion opacity stays
        # on the unchanged parent Nodes and applies to the resulting paint.
        add(gradient, "GradientStop", position=offset,
            colorValue=argb(stop_color, opacity * stop_opacity))


def build():
    scene = ET.parse(ROOT / "layout.xml").getroot()
    motion_before = motion_digest(scene)
    next_id = max(int(e.attrib["id"].split(":")[1])
                  for e in scene.iter() if "id" in e.attrib) + 1
    products = []
    for slug, slot_id in SLOTS.items():
        svg_path = SVG_ROOT / f"{slug}.svg"
        svg = ET.parse(svg_path).getroot()
        if svg.attrib.get("viewBox") != "0 0 1254 1254":
            raise ValueError(f"{slug}: expected the original 1254-square canvas")
        svg_paths, gradients = read_svg(svg, slug)
        slot = scene.find(f".//Node[@id='{slot_id}']")
        if slot is None or len(slot):
            raise ValueError(f"{slug}: static artwork slot is missing or already filled")
        canvas = add(slot, "Node", name=f"{slug} SVG canvas", id=f"0:{next_id}", x=-627, y=-627)
        next_id += 1
        contours = vertices = 0
        # SVG paints the last sibling on top; Rive paints the first on top.
        for paint_index, element in reversed(list(enumerate(svg_paths, 1))):
            if set(element.attrib) - {"id", "d", "fill", "fill-rule", "fill-opacity"}:
                raise ValueError(f"{slug}: unexpected SVG path attributes")
            label = element.attrib.get("id", f"color {paint_index}")
            shape = add(canvas, "Shape", name=f"{slug} {label}", id=f"0:{next_id}")
            next_id += 1
            geometry = parse_path(element.attrib["d"])
            if not geometry.paths:
                raise ValueError(f"{slug}: empty SVG path")
            geometry.append_rml(shape, slug)
            append_svg_fill(shape, element, gradients, slug)
            contours += len(geometry.paths)
            vertices += sum(len(path) for path in geometry.paths)
        products.append({
            "slug": slug, "file": f"../assets/svg/{slug}.svg", "artworkNodeId": slot_id,
            "viewBox": [0, 0, 1254, 1254], "shapes": len(svg_paths),
            "linearGradients": sum(e.attrib.get("fill", "").startswith("url(") for e in svg_paths),
            "contours": contours, "vertices": vertices,
            "svgBytes": svg_path.stat().st_size,
            "svgSha256": hashlib.sha256(svg_path.read_bytes()).hexdigest(),
        })
    counts = Counter(e.tag for e in scene.iter())
    forbidden = ("Image", "ImageAsset", "FontAsset", "Text", "TextStylePaint", "SVGAsset", "ScriptAsset")
    if any(counts[tag] for tag in forbidden):
        raise ValueError("Vector scene still contains a bitmap, font, text or script asset")
    if motion_digest(scene) != motion_before:
        raise ValueError("Static geometry conversion changed the motion graph")
    ET.indent(scene, "  ")
    ET.ElementTree(scene).write(ROOT / "scene.rml", encoding="unicode")
    report = {
        "representation": "hand-authored native Rive paths with solid fills and linear gradients",
        "resourceCounts": {tag: counts[tag] for tag in forbidden},
        "geometryCounts": {tag: counts[tag] for tag in (
            "Shape", "PointsPath", "StraightVertex", "CubicDetachedVertex", "LinearGradient", "GradientStop",
        )},
        "motionGraphSha256": motion_before,
        "motionGraphUnchanged": True,
        "products": products,
        "rmlBytes": (ROOT / "scene.rml").stat().st_size,
    }
    (ROOT / "vector-build.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({key: report[key] for key in (
        "resourceCounts", "geometryCounts", "motionGraphUnchanged", "rmlBytes",
    )}, indent=2))


if __name__ == "__main__":
    build()
