"""
Motion views for the copilot (Kiln only): a clip seen as a labelled filmstrip, an onion-skin strobe of
several frames in one image, 3D trails of feet, tail tip and head, and a gait diagram (foot heights and
the frames each foot is planted, with events). Renders use Workbench on the GPU; charts are drawn with
numpy. Used by bridge.op_motion.
"""

import math
import os

import bpy
import numpy as np
from mathutils import Vector

# 5x7 bitmap font (rows top to bottom, 5 bits each) for labels.
_F = {
    "0": (14, 17, 19, 21, 25, 17, 14), "1": (4, 12, 4, 4, 4, 4, 14), "2": (14, 17, 1, 2, 4, 8, 31), "3": (31, 2, 4, 2, 1, 17, 14),
    "4": (2, 6, 10, 18, 31, 2, 2), "5": (31, 16, 30, 1, 1, 17, 14), "6": (6, 8, 16, 30, 17, 17, 14), "7": (31, 1, 2, 4, 8, 8, 8),
    "8": (14, 17, 17, 14, 17, 17, 14), "9": (14, 17, 17, 15, 1, 2, 12), "A": (14, 17, 17, 31, 17, 17, 17), "B": (30, 17, 17, 30, 17, 17, 30),
    "C": (14, 17, 16, 16, 16, 17, 14), "D": (28, 18, 17, 17, 17, 18, 28), "E": (31, 16, 16, 30, 16, 16, 31), "F": (31, 16, 16, 30, 16, 16, 16),
    "G": (14, 17, 16, 23, 17, 17, 15), "H": (17, 17, 17, 31, 17, 17, 17), "I": (14, 4, 4, 4, 4, 4, 14), "J": (7, 2, 2, 2, 2, 18, 12),
    "K": (17, 18, 20, 24, 20, 18, 17), "L": (16, 16, 16, 16, 16, 16, 31), "M": (17, 27, 21, 21, 17, 17, 17), "N": (17, 17, 25, 21, 19, 17, 17),
    "O": (14, 17, 17, 17, 17, 17, 14), "P": (30, 17, 17, 30, 16, 16, 16), "Q": (14, 17, 17, 17, 21, 18, 13), "R": (30, 17, 17, 30, 20, 18, 17),
    "S": (15, 16, 16, 14, 1, 1, 30), "T": (31, 4, 4, 4, 4, 4, 4), "U": (17, 17, 17, 17, 17, 17, 14), "V": (17, 17, 17, 17, 17, 10, 4),
    "W": (17, 17, 17, 21, 21, 21, 10), "X": (17, 17, 10, 4, 10, 17, 17), "Y": (17, 17, 10, 4, 4, 4, 4), "Z": (31, 1, 2, 4, 8, 16, 31),
    " ": (0,) * 7, "-": (0, 0, 0, 31, 0, 0, 0), ".": (0, 0, 0, 0, 0, 12, 12), ":": (0, 12, 12, 0, 12, 12, 0), "/": (1, 1, 2, 4, 8, 16, 16),
    "_": (0, 0, 0, 0, 0, 0, 31), "%": (24, 25, 2, 4, 8, 19, 3), "(": (2, 4, 8, 8, 8, 4, 2), ")": (8, 4, 2, 2, 2, 4, 8),
}
_PALETTE = [(0.98, 0.55, 0.2), (0.3, 0.7, 1.0), (0.55, 0.9, 0.35), (1.0, 0.4, 0.55), (0.8, 0.6, 1.0), (1.0, 0.85, 0.3),
            (0.35, 0.95, 0.85), (0.95, 0.95, 0.95), (0.7, 0.45, 0.25), (0.5, 0.55, 1.0)]
_BG = np.array((0.075, 0.08, 0.09), dtype=np.float32)


def _text(img, x, y, s, color=(0.9, 0.9, 0.9), scale=2):
    """Draws text into img (H, W, 3; row 0 at the top) at top-left (x, y)."""
    H, W = img.shape[:2]
    cx = x
    for ch in str(s).upper():
        g = _F.get(ch, _F[" "])
        for r, bits in enumerate(g):
            for c in range(5):
                if bits >> (4 - c) & 1:
                    y0, x0 = y + r * scale, cx + c * scale
                    if 0 <= y0 < H - scale and 0 <= x0 < W - scale:
                        img[y0:y0 + scale, x0:x0 + scale] = color
        cx += 6 * scale
    return cx


def _line(img, pts, color, width=2):
    """A polyline through pixel points [(x, y)] (row 0 at the top)."""
    H, W = img.shape[:2]
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        n = int(max(abs(x1 - x0), abs(y1 - y0)) * 2) + 1
        xs = np.linspace(x0, x1, n)
        ys = np.linspace(y0, y1, n)
        for dx in range(-(width // 2), width - width // 2):
            for dy in range(-(width // 2), width - width // 2):
                xi = np.clip(np.round(xs + dx).astype(int), 0, W - 1)
                yi = np.clip(np.round(ys + dy).astype(int), 0, H - 1)
                img[yi, xi] = color


def _load(path):
    im = bpy.data.images.load(path, check_existing=False)
    w, h = im.size
    px = np.empty(w * h * 4, dtype=np.float32)
    im.pixels.foreach_get(px)
    bpy.data.images.remove(im)
    return px.reshape(h, w, 4)[::-1]  # row 0 at the top


def _save(img, path):
    h, w = img.shape[:2]
    rgba = np.ones((h, w, 4), dtype=np.float32)
    rgba[:, :, :3] = np.clip(img, 0, 1)
    out = bpy.data.images.new("_kiln_motion", w, h, alpha=False)
    out.pixels.foreach_set(rgba[::-1].ravel())
    out.filepath_raw = path
    out.file_format = "PNG"
    out.save()
    bpy.data.images.remove(out)
    return path


def _clip_frames(anim, clip, count):
    act = anim._action(clip)
    s, e = (int(round(v)) for v in act.frame_range)
    loop = anim._meta(act).get("loop", True)
    last = e - 1 if loop and e - s > 2 else e
    count = max(2, min(count, last - s + 1))
    return [int(round(s + (last - s) * k / (count - 1))) for k in range(count)], s, e


def _bounds_frames(s, e):
    return sorted({s, e, (s + e) // 2, s + (e - s) // 4, s + 3 * (e - s) // 4})


def strip(render, anim, clip, path, count=8, view="left", size=360):
    frames, s, e = _clip_frames(anim, clip, count)
    tiles = render({"path": path, "views": [view], "frames": frames, "quality": "fast", "size": size, "max_shots": 12,
                    "tiles_only": True, "frame_bounds": _bounds_frames(s, e)})["tiles"]
    imgs = [_load(t)[:, :, :3] for t in tiles]
    for t in tiles:
        try:
            os.remove(t)
        except OSError:
            pass
    h, w = imgs[0].shape[:2]
    cols = min(len(imgs), 4)
    rows = (len(imgs) + cols - 1) // cols
    gap = 4
    sheet = np.empty((rows * h + (rows - 1) * gap, cols * w + (cols - 1) * gap, 3), dtype=np.float32)
    sheet[:] = _BG
    for i, (im, f) in enumerate(zip(imgs, frames)):
        r, c = divmod(i, cols)
        y, x = r * (h + gap), c * (w + gap)
        sheet[y:y + h, x:x + w] = im
        _text(sheet, x + 8, y + 8, f"F{f}  {(f - s) / 30:.2f}S", (1.0, 0.85, 0.4))
    return _save(sheet, path), frames


def onion(render, anim, clip, path, count=6, view="left", size=720):
    frames, s, e = _clip_frames(anim, clip, count)
    tiles = render({"path": path, "views": [view], "frames": frames, "quality": "fast", "size": size, "max_shots": 12,
                    "tiles_only": True, "transparent": True, "frame_bounds": _bounds_frames(s, e)})["tiles"]
    layers = [_load(t) for t in tiles]
    for t in tiles:
        try:
            os.remove(t)
        except OSError:
            pass
    h, w = layers[0].shape[:2]
    out = np.empty((h, w, 3), dtype=np.float32)
    out[:] = _BG
    n = len(layers)
    for k, im in enumerate(layers):
        u = k / max(1, n - 1)
        tint = np.array((0.25 + 0.75 * u, 0.45 + 0.2 * (1 - abs(u - 0.5) * 2), 1.0 - 0.8 * u), dtype=np.float32)
        a = im[:, :, 3:4] * (0.38 + 0.62 * u)
        rgb = im[:, :, :3] * 0.45 + tint * 0.55
        out = out * (1 - a) + rgb * a
    _text(out, 10, 10, f"{clip}  F{frames[0]}-F{frames[-1]}  BLUE=EARLY ORANGE=LATE", (0.95, 0.95, 0.95))
    return _save(out, path), frames


def _trail_points(anim, clip):
    m = anim._Model()
    act = anim._action(clip)
    s, e = (int(round(v)) for v in act.frame_range)
    frames = list(range(s, e + 1))
    cur = anim.read(clip, frames)
    pts = {}
    names = []
    for lg in m.legs:
        names.append(("foot " + lg["name"], lg["joints"][-1], lg["toe0"]))
    tail = anim._tail_chain(m)
    if tail:
        names.append(("tail tip", tail[-1], m.t0[tail[-1]]))
    head = anim._stabilize_joint(m)
    if head:
        names.append(("head", head, m.t0[head]))
    if m.root:
        names.append(("root", m.root, m.h0[m.root]))
    for label, j, p0 in names[:10]:
        pts[label] = []
    for i in range(len(frames)):
        G = m.fk({j: cur[j][i][0] for j in cur}, {j: cur[j][i][1] for j in cur if cur[j][i][1] is not None})
        for label, j, p0 in names[:10]:
            pts[label].append(G[j] @ p0)
    return pts, m, frames


def trails(render, anim, clip, path, view="iso", size=720):
    pts, m, frames = _trail_points(anim, clip)
    temp, data = [], []
    radius = max(0.004, m.L * 0.012)
    try:
        for k, (label, seq) in enumerate(pts.items()):
            cu = bpy.data.curves.new("_kiln_trail", "CURVE")
            cu.dimensions = "3D"
            cu.bevel_depth = radius
            cu.bevel_resolution = 1
            sp = cu.splines.new("POLY")
            sp.points.add(len(seq) - 1)
            for p, v in zip(sp.points, seq):
                p.co = (v.x, v.y, v.z, 1.0)
            mat = bpy.data.materials.new("_kiln_trail")
            col = _PALETTE[k % len(_PALETTE)]
            mat.diffuse_color = (*col, 1.0)
            if mat.use_nodes and mat.node_tree:
                for nd in mat.node_tree.nodes:
                    if nd.type == "BSDF_PRINCIPLED":
                        nd.inputs["Base Color"].default_value = (*col, 1.0)
            cu.materials.append(mat)
            ob = bpy.data.objects.new("_kiln_trail", cu)
            bpy.context.scene.collection.objects.link(ob)
            temp.append(ob)
            data += [cu, mat]
        r = render({"path": path, "views": [view], "frames": [frames[len(frames) // 2]], "quality": "fast", "size": size})
    finally:
        for ob in temp:
            bpy.data.objects.remove(ob, do_unlink=True)
        for d in data:
            try:
                (bpy.data.curves if isinstance(d, bpy.types.Curve) else bpy.data.materials).remove(d)
            except Exception:  # noqa: BLE001
                pass
    img = _load(path)[:, :, :3].copy()
    y = 10
    for k, label in enumerate(pts):
        col = _PALETTE[k % len(_PALETTE)]
        img[y:y + 10, 10:24] = col
        _text(img, 30, y - 2, label, (0.95, 0.95, 0.95))
        y += 18
    return _save(img, path), list(pts)


def graph(anim, clip, path, width=1000):
    """Foot heights over the clip (one line per foot), a gait diagram (bars where each foot is planted),
    the body's height, and the clip's events."""
    pts, m, frames = _trail_points(anim, clip)
    act = anim._action(clip)
    legs = [k for k in pts if k.startswith("foot ")]
    rowh = 16
    top_h = 220
    body_h = 90
    H = 40 + top_h + 30 + body_h + 30 + rowh * max(1, len(legs)) + 40
    W = width
    img = np.empty((H, W, 3), dtype=np.float32)
    img[:] = _BG
    x0, x1 = 150, W - 20
    n = len(frames)
    fx = lambda i: x0 + (x1 - x0) * i / max(1, n - 1)
    _text(img, 10, 10, f"{clip}: FOOT HEIGHT, BODY HEIGHT, PLANTED FEET  ({n} FRAMES, {(n - 1) / 30:.2f}S)", (0.95, 0.95, 0.95))
    # Foot heights
    y0 = 40
    hmax = max([max(p.z for p in pts[k]) - m.ground for k in legs] + [m.L * 0.1])
    fy = lambda z: y0 + top_h - (top_h - 10) * max(0.0, (z - m.ground)) / hmax
    img[int(fy(m.ground)), x0:x1] = (0.4, 0.4, 0.45)
    _text(img, 10, y0 + 4, "FOOT", (0.7, 0.7, 0.75))
    _text(img, 10, y0 + 22, "HEIGHT", (0.7, 0.7, 0.75))
    planted = {}
    for k, label in enumerate(legs):
        col = _PALETTE[k % len(_PALETTE)]
        seq = pts[label]
        _line(img, [(fx(i), fy(p.z)) for i, p in enumerate(seq)], col, 2)
        rest = seq[0].z if seq else 0
        low = min(p.z for p in seq)
        planted[label] = [p.z - low < 0.04 * m.L for p in seq]
    # Body height
    y1 = y0 + top_h + 30
    if "root" in pts:
        zs = [p.z for p in pts["root"]]
        lo, hi = min(zs), max(zs)
        span = max(hi - lo, m.L * 0.02)
        _line(img, [(fx(i), y1 + body_h - body_h * (z - lo) / span) for i, z in enumerate(zs)], (0.85, 0.85, 0.9), 2)
        _text(img, 10, y1 + 4, "BODY", (0.7, 0.7, 0.75))
        _text(img, 10, y1 + 22, f"{span:.3f}", (0.6, 0.6, 0.65))
    # Gait diagram
    y2 = y1 + body_h + 30
    for k, label in enumerate(legs):
        col = np.array(_PALETTE[k % len(_PALETTE)], dtype=np.float32)
        y = y2 + k * rowh
        _text(img, 10, y + 2, label[5:][:18], col * 0.9 + 0.1, scale=1)
        for i in range(n - 1):
            if planted[label][i]:
                img[y + 2:y + rowh - 2, int(fx(i)):int(fx(i + 1)) + 1] = col * 0.85
    # Frame ticks and events
    yb = y2 + rowh * max(1, len(legs)) + 6
    step = 5 if n <= 60 else 10 if n <= 150 else 30
    for i in range(0, n, step):
        x = int(fx(i))
        img[40:yb, x] = img[40:yb, x] * 0.7 + 0.08
        _text(img, x - 6, yb + 4, str(frames[i]), (0.6, 0.6, 0.65), scale=1)
    for mk in act.pose_markers:
        i = mk.frame - frames[0]
        if 0 <= i < n and not mk.name.startswith("Step_"):
            x = int(fx(i))
            img[40:yb, max(0, x - 1):x + 1] = (1.0, 0.35, 0.3)
            _text(img, x + 4, 42, mk.name, (1.0, 0.5, 0.45), scale=1)
    notes = []
    for label in legs:
        pl = planted[label]
        notes.append(f"{label[5:]}: planted {100 * sum(pl) / max(1, len(pl)):.0f}%")
    return _save(img, path), notes
