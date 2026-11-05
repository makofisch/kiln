"""
Making Blender scenes look right in Kiln's live viewer (glTF).

glTF only carries image textures and plain values. Procedural shading (noise, ramps, mixes) exports
as plain white, which made realistic scenes look washed out in the viewer. For the viewer export we
temporarily replace such inputs with an approximate colour or value, computed from the node tree,
then restore the material exactly. Renders and .blend files never see the change.
"""

import contextlib
import math

import bpy
import numpy as np

_image_means = {}


def _srgb_to_linear(c):
    c = np.asarray(c, dtype=np.float64)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def _image_mean(img):
    """Average colour of an image, in linear RGBA (cached per image and size)."""
    if img is None or not img.size[0] or not img.size[1]:
        return (0.5, 0.5, 0.5, 1.0)
    key = (img.name, tuple(img.size))
    hit = _image_means.get(key)
    if hit:
        return hit
    try:
        n = img.size[0] * img.size[1] * 4
        px = np.empty(n, dtype=np.float32)
        img.pixels.foreach_get(px)
        px = px.reshape(-1, 4)
        if len(px) > 262144:
            px = px[:: len(px) // 262144]
        mean = px.mean(0)
        rgb = mean[:3] if img.is_float else _srgb_to_linear(mean[:3])
        out = (float(rgb[0]), float(rgb[1]), float(rgb[2]), 1.0)
    except Exception:  # noqa: BLE001
        out = (0.5, 0.5, 0.5, 1.0)
    _image_means[key] = out
    return out


def _as_color(v):
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return (float(v), float(v), float(v), 1.0)
    t = tuple(float(x) for x in v)
    return t if len(t) == 4 else (t + (1.0,))[:4] if len(t) == 3 else (t[0], t[0], t[0], 1.0)


def _as_float(v):
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    t = tuple(float(x) for x in v)
    return sum(t[:3]) / min(3, len(t)) if t else None


def _input(node, *names):
    for n in names:
        s = node.inputs.get(n)
        if s is not None:
            return s
    return None


def _value(sock, depth):
    """Approximate value arriving at an input socket."""
    if sock is None:
        return None
    if sock.is_linked and sock.links:
        return _approx(sock.links[0].from_socket, depth + 1)
    try:
        v = sock.default_value
    except AttributeError:
        return None
    return tuple(v) if hasattr(v, "__len__") else float(v)


def _approx(out_sock, depth=0):
    """Approximate average value of a node output (colour tuple or float)."""
    if depth > 14 or out_sock is None:
        return None
    node = out_sock.node
    t = node.type
    if t == "TEX_IMAGE" or t == "TEX_ENVIRONMENT":
        return _image_mean(node.image) if out_sock.name != "Alpha" else 1.0
    if t == "RGB":
        return tuple(node.outputs[0].default_value)
    if t == "VALUE":
        return float(node.outputs[0].default_value)
    if t == "VALTORGB":  # colour ramp: average colour across 0..1
        els = list(node.color_ramp.elements)
        if not els:
            return None
        if len(els) == 1:
            return tuple(els[0].color)
        acc = np.zeros(4)
        span = 0.0
        pts = [(0.0, els[0].color)] + [(e.position, e.color) for e in els] + [(1.0, els[-1].color)]
        for (p0, c0), (p1, c1) in zip(pts, pts[1:]):
            w = max(0.0, p1 - p0)
            acc += w * (np.array(c0) + np.array(c1)) / 2
            span += w
        c = acc / max(span, 1e-6)
        return tuple(c) if out_sock.name != "Alpha" else float(c[3])
    if t in ("MIX", "MIX_RGB"):
        fac = _as_float(_value(_input(node, "Factor", "Fac"), depth))
        fac = 0.5 if fac is None else max(0.0, min(1.0, fac))
        if t == "MIX" and getattr(node, "data_type", "RGBA") == "FLOAT":
            a, b = _as_float(_value(node.inputs[2], depth)), _as_float(_value(node.inputs[3], depth))
            if a is None or b is None:
                return a if b is None else b
            return a + (b - a) * fac
        socks = [s for s in node.inputs if s.type == "RGBA"]
        a = _as_color(_value(socks[0], depth)) if len(socks) > 0 else None
        b = _as_color(_value(socks[1], depth)) if len(socks) > 1 else None
        if a is None or b is None:
            return a if b is None else b
        blend = getattr(node, "blend_type", "MIX")
        if blend == "MULTIPLY":
            mixed = [x * (1 - fac + fac * y) for x, y in zip(a, b)]
        elif blend == "ADD":
            mixed = [x + fac * y for x, y in zip(a, b)]
        else:
            mixed = [x + (y - x) * fac for x, y in zip(a, b)]
        return tuple(mixed)
    if t == "TEX_CHECKER":
        a, b = _as_color(_value(_input(node, "Color1"), depth)), _as_color(_value(_input(node, "Color2"), depth))
        return tuple((np.array(a) + np.array(b)) / 2) if a and b else None
    if t == "TEX_BRICK":
        a, b = _as_color(_value(_input(node, "Color1"), depth)), _as_color(_value(_input(node, "Color2"), depth))
        m = _as_color(_value(_input(node, "Mortar"), depth))
        if a and b and m:
            return tuple(np.array(a) * 0.43 + np.array(b) * 0.43 + np.array(m) * 0.14)
    if t == "TEX_SKY":
        return (0.3, 0.5, 0.85, 1.0)
    if t.startswith("TEX_"):  # noise, voronoi, wave, gradient, magic…: mid grey / 0.5
        return 0.5 if out_sock.type == "VALUE" else (0.5, 0.5, 0.5, 1.0)
    if t in ("HUE_SAT", "BRIGHTCONTRAST", "GAMMA", "CURVE_RGB", "RGBTOBW", "INVERT"):
        v = _value(_input(node, "Color"), depth)
        if t == "INVERT" and v is not None:
            c = _as_color(v)
            return tuple([1 - x for x in c[:3]] + [c[3]])
        if t == "RGBTOBW":
            return _as_float(v)
        return v
    if t in ("COMBINE_COLOR", "COMBRGB"):
        vals = [_as_float(_value(s, depth)) for s in node.inputs[:3]]
        return tuple([0.5 if v is None else v for v in vals] + [1.0])
    if t in ("SEPARATE_COLOR", "SEPRGB"):
        c = _as_color(_value(node.inputs[0], depth))
        if not c:
            return None
        idx = {"Red": 0, "R": 0, "Green": 1, "G": 1, "Blue": 2, "B": 2}.get(out_sock.name, 0)
        return c[idx]
    if t == "MAP_RANGE":
        lo, hi = _as_float(_value(_input(node, "To Min"), depth)), _as_float(_value(_input(node, "To Max"), depth))
        if lo is not None and hi is not None:
            return (lo + hi) / 2
    if t == "MATH":
        a = _as_float(_value(node.inputs[0], depth))
        b = _as_float(_value(node.inputs[1], depth)) if len(node.inputs) > 1 else None
        op = node.operation
        try:
            if op == "MULTIPLY" and a is not None and b is not None:
                return a * b
            if op == "ADD" and a is not None and b is not None:
                return a + b
            if op == "SUBTRACT" and a is not None and b is not None:
                return a - b
        except Exception:  # noqa: BLE001
            return None
        return a
    if t == "REROUTE":
        return _value(node.inputs[0], depth)
    return None


def _direct_image(node):
    """Inputs the glTF exporter already handles: an image texture (optionally through a multiply mix),
    or vertex colors (exported as the mesh's COLOR_0)."""
    if node.type in ("TEX_IMAGE", "VERTEX_COLOR", "ATTRIBUTE"):
        return True
    if node.type in ("MIX", "MIX_RGB") and getattr(node, "blend_type", "") == "MULTIPLY":
        return any(s.is_linked and s.links[0].from_node.type == "TEX_IMAGE" for s in node.inputs)
    if node.type in ("SEPARATE_COLOR", "SEPRGB"):  # roughness / metallic channels of an image
        s = node.inputs[0]
        return s.is_linked and s.links[0].from_node.type == "TEX_IMAGE"
    return node.type == "NORMAL_MAP"


@contextlib.contextmanager
def viewer_materials():
    """Temporarily swap procedural Principled inputs for approximate plain values."""
    changes = []
    for mat in bpy.data.materials:
        tree = mat.node_tree
        if not mat.users or tree is None:
            continue
        for node in tree.nodes:
            if node.type != "BSDF_PRINCIPLED":
                continue
            for name in ("Base Color", "Roughness", "Metallic", "Emission Color", "Emission Strength", "Alpha"):
                sock = node.inputs.get(name)
                if sock is None or not sock.is_linked or not sock.links:
                    continue
                link = sock.links[0]
                if _direct_image(link.from_node):
                    continue
                v = _approx(link.from_socket)
                if v is None:
                    v = (0.6, 0.6, 0.6, 1.0) if sock.type == "RGBA" else None
                if v is None:
                    continue
                try:
                    old = tuple(sock.default_value) if sock.type == "RGBA" else float(sock.default_value)
                    new = _as_color(v) if sock.type == "RGBA" else _as_float(v)
                    changes.append((tree, link.from_socket, sock, old))
                    tree.links.remove(link)
                    sock.default_value = new
                except Exception:  # noqa: BLE001
                    continue
    try:
        yield len(changes)
    finally:
        for tree, from_sock, to_sock, old in reversed(changes):
            try:
                to_sock.default_value = old
                tree.links.new(from_sock, to_sock)
            except Exception:  # noqa: BLE001
                pass


@contextlib.contextmanager
def viewer_lights():
    """glTF has no area lights, so the viewer lost every area light (fills, softboxes, window light).
    For the viewer export each one becomes a wide spot light with the same on-axis intensity: an area
    light of power P sends P/π straight ahead, a spot of power P' sends P'/4π, so P' = 4P."""
    changed = []
    for light in bpy.data.lights:
        if light.type != "AREA" or not light.users:
            continue
        try:
            energy, name = light.energy, light.name
            light.type = "SPOT"
            light = bpy.data.lights[name]  # re-fetched: the spot settings exist only on a spot
            changed.append((name, energy, light.spot_size, light.spot_blend))
            light.energy = energy * 4.0
            light.spot_size = math.radians(170)
            light.spot_blend = 1.0
        except Exception:  # noqa: BLE001
            pass
    try:
        yield len(changed)
    finally:
        for name, energy, size, blend in changed:
            try:
                light = bpy.data.lights[name]
                light.spot_size, light.spot_blend = size, blend
                light.type = "AREA"
                bpy.data.lights[name].energy = energy
            except Exception:  # noqa: BLE001
                pass


def world_info(scene):
    """The world's background colour (linear RGB) and strength, approximated like materials."""
    w = scene.world
    if w is None:
        return None
    try:
        tree = w.node_tree
        bg = next((n for n in tree.nodes if n.type == "BACKGROUND"), None) if tree else None
        if bg is not None:
            c = _as_color(_value(bg.inputs["Color"], 0)) or (0.05, 0.05, 0.05, 1.0)
            s = _as_float(_value(bg.inputs["Strength"], 0))
            s = 1.0 if s is None else s  # a strength of 0 (a dark night world) is a value, not "missing"
            return c[:3], s
        return tuple(w.color)[:3], 1.0
    except Exception:  # noqa: BLE001
        return tuple(w.color)[:3], 1.0
