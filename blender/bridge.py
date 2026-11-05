"""
Kiln bridge: runs inside headless Blender and serves requests from the Kiln server.

Protocol: one JSON request per stdin line ({"id": n, "op": "...", ...}); one reply per request on
stdout, as a single line starting with "@@KILN ". Blender prints its own lines to stdout too, so the
server ignores everything without the marker. The Python namespace used by "exec" persists between
requests (like a REPL) until the scene is replaced.
"""

import contextlib
import hashlib
import io
import json
import math
import os
import sys
import time
import traceback

import bmesh
import bpy
import mathutils
import numpy as np

sys.dont_write_bytecode = True  # no __pycache__ next to the app's scripts (or another app's, see op_ext)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import kiln  # noqa: E402  (helpers offered to the copilot's code)
import kiln_roblox  # noqa: E402  (Roblox target: preview lighting, readiness check)
import checks  # noqa: E402
from checks import check_scene  # noqa: E402
from viewer_export import viewer_lights, viewer_materials, world_info  # noqa: E402

MARK = "@@KILN "
_out = sys.stdout
NS = {}
MESHLIKE = {"MESH", "CURVE", "SURFACE", "META", "FONT", "CURVES", "POINTCLOUD", "VOLUME"}


def _finite(v):
    """NaN and infinity are not JSON: the server would drop the whole reply and wait for a timeout."""
    if isinstance(v, float):
        return v if math.isfinite(v) else None
    if isinstance(v, dict):
        return {k: _finite(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_finite(x) for x in v]
    return v


def reply(obj):
    try:
        text = json.dumps(obj, ensure_ascii=True, default=str, allow_nan=False)
    except ValueError:
        text = json.dumps(_finite(obj), ensure_ascii=True, default=str)
    _out.write(MARK + text + "\n")
    _out.flush()


def quiet_prefs():
    """No .blend1 backup files next to every save."""
    try:
        bpy.context.preferences.filepaths.save_version = 0
    except Exception:  # noqa: BLE001
        pass


def _keepable(v, depth=0):
    """Whether a value from the copilot's namespace can outlive the scene it was made in: functions, classes,
    modules and plain data can; anything holding Blender data (objects, meshes, materials) can't, because
    loading a scene frees that data and touching it afterwards raises "StructRNA ... has been removed"."""
    import types
    if v is None or isinstance(v, (bool, int, float, complex, str, bytes, range)):
        return True
    if isinstance(v, (types.FunctionType, types.BuiltinFunctionType, types.ModuleType, type)):
        return True
    if isinstance(v, (bpy.types.bpy_struct, bpy.types.bpy_prop_collection)):
        return False
    if isinstance(v, (mathutils.Vector, mathutils.Matrix, mathutils.Euler, mathutils.Quaternion, mathutils.Color)):
        return getattr(v, "owner", None) is None
    if isinstance(v, np.ndarray):
        return v.dtype != object
    if depth < 2 and isinstance(v, (list, tuple, set, frozenset)):
        return all(_keepable(x, depth + 1) for x in list(v)[:5000])
    if depth < 2 and isinstance(v, dict):
        return all(_keepable(k, depth + 1) and _keepable(x, depth + 1) for k, x in list(v.items())[:5000])
    return False


def fresh_namespace(keep=False):
    """keep: the same project's scene is being restored (a failed step rolled back, an undo): the copilot's own
    functions, classes and plain values stay; variables that held Blender data go (look those up again)."""
    kept = {k: v for k, v in NS.items() if not k.startswith("__") and _keepable(v)} if keep else {}
    NS.clear()
    NS.update(kept)
    NS.update({
        "__name__": "__kiln__",
        "bpy": bpy, "bmesh": bmesh, "mathutils": mathutils, "math": math, "np": np, "kiln": kiln,
        "Vector": mathutils.Vector, "Matrix": mathutils.Matrix, "Euler": mathutils.Euler,
        "Quaternion": mathutils.Quaternion, "radians": math.radians, "degrees": math.degrees,
    })


def object_mode():
    """Edits made in Edit Mode only reach the mesh (and the export) after leaving it."""
    try:
        if bpy.context.mode != "OBJECT":
            bpy.ops.object.mode_set(mode="OBJECT")
    except Exception:  # noqa: BLE001
        pass


# ---------------------------------------------------------------------------------------------
# Scene scan: summary for the copilot and a fingerprint to know whether anything changed.
# ---------------------------------------------------------------------------------------------

def principled(mat):
    if not mat or not mat.node_tree:
        return None
    for n in mat.node_tree.nodes:
        if n.type == "BSDF_PRINCIPLED":
            return n
    return None


def linear_to_hex(rgba):
    def enc(c):
        c = max(0.0, min(1.0, c))
        return c * 12.92 if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055
    return "#%02x%02x%02x" % tuple(int(round(enc(c) * 255)) for c in rgba[:3])


def material_info(mat):
    p = principled(mat)
    info = {"name": mat.name}
    if p:
        g = lambda k: p.inputs[k].default_value if k in p.inputs else None  # noqa: E731
        base = g("Base Color")
        info["color"] = linear_to_hex(base) if base is not None else None
        info["metallic"] = round(float(g("Metallic") or 0), 2)
        info["roughness"] = round(float(g("Roughness") or 0), 2)
        es = g("Emission Strength")
        if es:
            info["emission"] = round(float(es), 2)
        # Not shown in the summary, but a change to any of these is a change to the scene.
        ec, al = g("Emission Color"), g("Alpha")
        info["_more"] = (tuple(round(c, 3) for c in ec[:3]) if ec is not None else None, round(float(al), 3) if al is not None else None,
                         mat.use_backface_culling, [(n.type, n.image.name, tuple(n.image.size), n.image.get("kiln_rev", 0), n.interpolation) for n in mat.node_tree.nodes if n.type == "TEX_IMAGE" and n.image],
                         len(mat.node_tree.links))
        textured = any(n.type == "TEX_IMAGE" for n in mat.node_tree.nodes)
        procedural = any(n.type.startswith("TEX_") and n.type != "TEX_IMAGE" for n in mat.node_tree.nodes)
        if textured:
            info["image_texture"] = True
        if procedural:
            info["procedural_texture"] = True
    return info


def scan(limit=150):
    object_mode()
    scene = bpy.context.scene
    dg = bpy.context.evaluated_depsgraph_get()
    h = hashlib.md5()
    objects, tris_total, verts_total = [], 0, 0
    lo, hi = [math.inf] * 3, [-math.inf] * 3
    seen = {}  # copies of one mesh (a scattered forest) are read once
    placed = {"pieces": set(), "placements": 0, "tris": 0}
    for ob in sorted(scene.objects, key=lambda o: o.name):
        tris = verts = 0
        visible = ob.visible_get()
        piece = ob.instance_collection if ob.instance_type == "COLLECTION" and ob.instance_collection is not None and ob.instance_collection.get("kiln_piece") else None
        if piece is not None and visible:
            tris = int(piece.get("kiln_piece_tris", 0))
            placed["pieces"].add(piece.name)
            placed["placements"] += 1
            placed["tris"] += tris
            for i in range(3):
                lo[i], hi[i] = min(lo[i], ob.matrix_world.translation[i]), max(hi[i], ob.matrix_world.translation[i])
        if ob.type in MESHLIKE:
            key = ob.data.name if ob.type == "MESH" and not len(ob.modifiers) else None
            hit = seen.get(key) if key is not None else None
            if hit is not None:
                tris, verts, digest = hit
            else:
                sub = hashlib.md5()
                ev = ob.evaluated_get(dg)
                try:
                    me = ev.to_mesh()
                except Exception:  # noqa: BLE001
                    me = None
                if me is not None:
                    me.calc_loop_triangles()
                    tris, verts = len(me.loop_triangles), len(me.vertices)
                    if verts:
                        co = np.empty(verts * 3, dtype=np.float32)
                        me.vertices.foreach_get("co", co)
                        sub.update(co.tobytes())
                        # UVs, which face has which material, and smooth shading are changes too (they used to go unsaved).
                        npoly = len(me.polygons)
                        if npoly:
                            mi = np.empty(npoly, dtype=np.int32)
                            me.polygons.foreach_get("material_index", mi)
                            sm = np.empty(npoly, dtype=bool)
                            me.polygons.foreach_get("use_smooth", sm)
                            sub.update(mi.tobytes())
                            sub.update(np.packbits(sm).tobytes())
                        uvl = me.uv_layers.active
                        if uvl is not None and len(me.loops):
                            uv = np.empty(len(me.loops) * 2, dtype=np.float32)
                            uvl.uv.foreach_get("vector", uv)
                            sub.update(uv.tobytes())
                    ev.to_mesh_clear()
                digest = sub.digest()
                if key is not None:
                    seen[key] = (tris, verts, digest)
            h.update(digest)
            if visible:
                for c in ob.bound_box:
                    w = ob.matrix_world @ mathutils.Vector(c)
                    for i in range(3):
                        lo[i], hi[i] = min(lo[i], w[i]), max(hi[i], w[i])
        tris_total += tris
        verts_total += verts
        mw = [round(x, 4) for row in ob.matrix_world for x in row]
        mats = [s.material.name for s in ob.material_slots if s.material]
        h.update(repr((ob.name, ob.type, mw, tris, verts, mats, visible, ob.parent.name if ob.parent else None, ob.parent_bone,
                       [(m.name, m.type, m.show_viewport) for m in ob.modifiers], sorted(c.name for c in ob.users_collection),
                       piece.name if piece is not None else None, ob.get("kiln_role"), ob.get("kiln_collides_for"), ob.get("kiln_path"), ob.hide_render,
                       ob.get("kiln_socket"), ob.get("kiln_mates"), ob.get("kiln_part"))).encode())
        if len(objects) < limit:
            e = {
                "name": ob.name, "type": ob.type,
                "location": [round(v, 3) for v in ob.location],
                "dimensions": [round(v, 3) for v in ob.dimensions],
            }
            rot = [round(math.degrees(a), 1) for a in ob.rotation_euler]
            if any(rot):
                e["rotation_deg"] = rot
            if any(abs(s - 1) > 1e-4 for s in ob.scale):
                e["scale"] = [round(v, 3) for v in ob.scale]
            if tris:
                e["tris"] = tris
            if mats:
                e["materials"] = mats
            if ob.modifiers:
                e["modifiers"] = [m.type.lower() for m in ob.modifiers]
            if ob.parent:
                e["parent"] = ob.parent.name
            cols = [c.name for c in ob.users_collection if c != scene.collection]
            if cols:
                e["collection"] = cols[0]
            if not visible:
                e["hidden"] = True
            if piece is not None:
                e["piece"] = piece.name[6:]
            if ob.get("kiln_role"):
                e["role"] = ob["kiln_role"]
            if ob.get("kiln_socket"):
                e["socket"] = ob["kiln_socket"]
            if ob.get("kiln_part"):
                e["part"] = ob["kiln_part"]
            objects.append(e)
    materials = [material_info(m) for m in bpy.data.materials if m.users]
    for m in materials:
        h.update(repr(sorted((k, repr(v)) for k, v in m.items())).encode())
        m.pop("_more", None)
    h.update(str(scene.get("kiln_rig", "")).encode())
    # Pieces brought in from other projects, and materials left to Roblox's own.
    h.update(repr([(c.name, c.get("kiln_piece"), c.get("kiln_piece_version"), c.get("kiln_piece_fingerprint")) for c in sorted(bpy.data.collections, key=lambda c: c.name) if c.get("kiln_piece")]).encode())
    h.update(repr(sorted((m.name, m["roblox_material"]) for m in bpy.data.materials if m.users and m.get("roblox_material"))).encode())
    animated = any(ob.animation_data and ob.animation_data.action for ob in scene.objects)
    h.update(repr((animated, scene.frame_start, scene.frame_end)).encode())
    summary = {
        "objects": len(scene.objects), "tris": tris_total, "verts": verts_total,
        "list": objects, "truncated": len(scene.objects) > limit, "materials": materials,
        "collections": [c.name for c in bpy.data.collections if c.users],
        "animated": animated,
    }
    if placed["placements"]:
        summary["placed"] = {"pieces": len(placed["pieces"]), "placements": placed["placements"], "tris": placed["tris"]}
    if lo[0] != math.inf:
        summary["bounds"] = {"min": [round(v, 3) for v in lo], "max": [round(v, 3) for v in hi],
                             "size": [round(hi[i] - lo[i], 3) for i in range(3)]}
    if animated:
        summary["frames"] = [scene.frame_start, scene.frame_end, scene.render.fps]
    wi = world_info(scene)
    summary["world"] = {"color": linear_to_hex(wi[0]), "strength": round(float(wi[1]), 2)} if wi else None
    lights = [o for o in scene.objects if o.type == "LIGHT" and o.visible_get()]
    summary["lights"] = len(lights)
    rig = kiln.rig.armature(False)
    if rig is not None:
        try:
            cur = rig.animation_data.action.name if rig.animation_data and rig.animation_data.action else None
            keys = ("name", "frames", "length", "loop", "in_place", "speed", "turn", "priority", "generator")
            fps_ = kiln.anim.clip_fingerprints()
            summary["rig"] = {
                "joints": len(rig.data.bones),
                "clips": [dict({k: c[k] for k in keys}, markers=len(c["markers"]), fp=fps_.get(c["name"], "")) for c in kiln.anim.clips()],
                "current": cur if cur and not cur.startswith("_") else None,
                "anim": kiln.anim.fingerprint(),
            }
            h.update(summary["rig"]["anim"].encode())
        except Exception as e:  # noqa: BLE001
            summary["rig"] = {"joints": len(rig.data.bones), "clips": [], "error": str(e)[:200]}
    h.update(repr((summary["world"], [(o.data.type, round(o.data.energy, 2), tuple(round(c, 3) for c in o.data.color)) for o in lights])).encode())
    return summary, h.hexdigest()


# ---------------------------------------------------------------------------------------------
# Ops
# ---------------------------------------------------------------------------------------------

def op_ping(req):
    return {"version": bpy.app.version_string, "python": sys.version.split()[0]}


def op_new(req):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    quiet_prefs()
    fresh_namespace()
    summary, fp = scan()
    return {"summary": summary, "fingerprint": fp}


def op_open(req):
    bpy.ops.wm.open_mainfile(filepath=req["path"], load_ui=False)
    fresh_namespace(keep=bool(req.get("keep")))
    summary, fp = scan()
    return {"summary": summary, "fingerprint": fp}


def format_error(code):
    etype, e, tb = sys.exc_info()
    lines = code.splitlines()
    out = []
    for f in [f for f in traceback.extract_tb(tb) if f.filename == "<run_python>"][-3:]:
        src = lines[f.lineno - 1].strip() if f.lineno and 0 < f.lineno <= len(lines) else ""
        out.append("line %d: %s" % (f.lineno, src))
    out.append("".join(traceback.format_exception_only(etype, e)).strip())
    if etype is NameError:
        out.append("(Functions and plain values from earlier run_python calls are kept. Variables that held Blender data "
                   "(objects, meshes, materials) are dropped when the scene is restored after a failed step, and everything "
                   "is gone after Blender restarts: define it again, or look the data up by name with kiln.obj(\"Name\") / "
                   "bpy.data.materials[\"Name\"].)")
    elif etype is ReferenceError:
        out.append("(A variable still points at Blender data that no longer exists: the scene was restored after a failed "
                   "step, or the object was deleted. Look it up again by name, e.g. kiln.obj(\"Name\").)")
    return "\n".join(out)


def _context(req):
    """The project's units and Roblox target, for the checks (and kiln.zfight in the copilot's code)."""
    if req.get("units") in ("m", "studs"):
        checks.CONTEXT["units"] = req["units"]
    if "roblox" in req:
        checks.CONTEXT["roblox"] = bool(req["roblox"])


def op_exec(req):
    code = req["code"]
    _context(req)
    if req.get("project_dir"):
        kiln.PROJECT_DIR = req["project_dir"]
    names_before = {o.name for o in bpy.context.scene.objects}
    buf = io.StringIO()
    error = None
    try:
        compiled = compile(code, "<run_python>", "exec")
    except SyntaxError as e:
        src = (e.text or "").rstrip()
        return {"ok": False, "error": "SyntaxError: %s (line %s)\n  %s" % (e.msg, e.lineno, src), "output": ""}
    try:
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
            exec(compiled, NS)
    except Exception:  # noqa: BLE001
        error = format_error(code)
    try:
        bpy.context.view_layer.update()
    except Exception:  # noqa: BLE001
        pass
    summary, fp = scan()
    names_after = {o.name for o in bpy.context.scene.objects}
    output = buf.getvalue()
    if len(output) > 8000:
        output = output[:3500] + "\n… (%d characters cut) …\n" % (len(output) - 7000) + output[-3500:]
    issues = None
    skipped = bool(req.get("check")) and fp != req.get("previous") and summary["tris"] > 400000
    # A quick look for clashing surfaces and floating parts after every change. Parts sunk below
    # the ground are usually intentional (planted posts, foundations), so only check_scene reports them.
    if req.get("check") and fp != req.get("previous") and summary["tris"] <= 400000:
        try:
            c = check_scene(max_tris=400000)
            issues = {"zfight": c["zfight"][:8], "zfight_pairs": c["zfight_pairs"], "zfight_rule": c["zfight_rule"], "floating": c["floating"][:8]}
        except Exception:  # noqa: BLE001
            issues = None
    return {
        "ok": error is None, "error": error, "output": output, "summary": summary, "fingerprint": fp,
        "added": sorted(names_after - names_before), "removed": sorted(names_before - names_after), "issues": issues,
        "check_skipped": skipped,
    }


def op_check(req):
    _context(req)
    tol, nudge = req.get("tolerance"), req.get("nudge")
    r = check_scene(tol=float(tol) if tol else None, fix=bool(req.get("fix")), nudge=float(nudge) if nudge else None)
    if r["moved"]:
        summary, fp = scan()
        r["summary"], r["fingerprint"] = summary, fp
    return r


def op_roblox_check(req):
    """What won't survive the trip to Roblox (materials, budgets), and a line about the place's lighting."""
    if req.get("project_dir"):
        kiln.PROJECT_DIR = req["project_dir"]
    r = kiln_roblox.check(tris_per_part=int(req.get("tris_per_part", 20000)), max_joints=int(req.get("max_joints", 50)),
                          units=req.get("units") or bpy.context.scene.get("kiln_units") or "m")
    r["lighting"] = kiln_roblox.describe(req.get("roblox_lighting"))
    return r


def op_parts(req):
    """Each top-level model as an exporter needs it (origin, size, triangles, materials, sockets) and how the sockets fit."""
    import kiln_parts
    if req.get("project_dir"):
        kiln.PROJECT_DIR = req["project_dir"]
    out = {"models": kiln_parts.models()}
    try:
        out["fit"] = kiln_parts.fit_report() if any(s["mates"] for m in out["models"] for s in m["sockets"]) else None
    except Exception as e:  # noqa: BLE001
        out["fit"] = {"ok": False, "pairs": [], "unpaired": [], "summary": "The fit check failed: %s" % e}
    return out


def op_scene(req):
    summary, fp = scan(limit=int(req.get("limit", 150)))
    return {"summary": summary, "fingerprint": fp}


def op_save(req):
    object_mode()
    # Compression costs a few milliseconds and saves about a third of the disk (history keeps many copies).
    bpy.ops.wm.save_as_mainfile(filepath=req["path"], copy=True, check_existing=False, compress=True)
    return {}


def op_export(req):
    object_mode()
    fmt, path = req["format"], req["path"]
    if fmt == "glb":
        rig = kiln.rig.armature(False)
        viewer = bool(req.get("viewer"))
        # A Kiln rig goes to the live viewer at rest (its clips travel as JSON, see op_clips_export);
        # other GLB exports carry every clip as a glTF animation.
        animated = any(o.animation_data and o.animation_data.action and o != rig for o in bpy.context.scene.objects) or (rig is not None and not viewer)
        opts = dict(filepath=path, export_format="GLB", export_apply=True, export_yup=True, use_visible=True,
                    export_cameras=False, export_lights=True, export_animations=animated, export_skins=True)
        if rig is not None and not viewer:
            opts.update(export_animation_mode="ACTIONS", export_def_bones=False)
        prev_pose = None
        if rig is not None and viewer:
            prev_pose = rig.data.pose_position
            rig.data.pose_position = "REST"
            bpy.context.view_layer.update()
        # The live viewer (not a final export) gets approximate colours for procedural materials.
        if viewer:
            opts["export_import_convert_lighting_mode"] = "COMPAT"
            opts["export_image_format"] = "JPEG"
            opts["export_jpeg_quality"] = 88
            opts["use_renderable"] = True  # colliders and tracks are data, not something to look at
        try:
            with (viewer_materials() if viewer else contextlib.nullcontext()), (viewer_lights() if viewer else contextlib.nullcontext()):
                try:
                    bpy.ops.export_scene.gltf(**opts)
                except TypeError:
                    for key in ("export_import_convert_lighting_mode", "export_image_format", "export_jpeg_quality", "use_renderable"):
                        opts.pop(key, None)
                    bpy.ops.export_scene.gltf(**opts)
        finally:
            if prev_pose is not None:
                rig.data.pose_position = prev_pose
                bpy.context.view_layer.update()
    elif fmt == "fbx":
        # Rigs export with their armature, skins and every clip as a take.
        fbx = dict(filepath=path, use_mesh_modifiers=True, path_mode="COPY", embed_textures=True,
                   add_leaf_bones=False, bake_anim=True, bake_anim_use_all_actions=True, bake_anim_use_nla_strips=False)
        try:
            bpy.ops.export_scene.fbx(use_visible=True, **fbx)  # hidden scatter templates and baked-away meshes stay out
        except TypeError:
            bpy.ops.export_scene.fbx(**fbx)
    elif fmt == "obj":
        bpy.ops.wm.obj_export(filepath=path, apply_modifiers=True, export_materials=True)
    elif fmt == "stl":
        bpy.ops.wm.stl_export(filepath=path, apply_modifiers=True)
    elif fmt == "blend":
        bpy.ops.wm.save_as_mainfile(filepath=path, copy=True, check_existing=False)
    else:
        return {"ok": False, "error": "unknown format %s" % fmt}
    return {"path": path}


VIEWS = {
    "iso": (1.0, -1.0, 0.8), "iso_back": (-1.0, 1.0, 0.8), "hero": (0.75, -1.0, 0.3),
    "front": (0.0, -1.0, 0.12), "back": (0.0, 1.0, 0.12), "left": (-1.0, 0.0, 0.12),
    "right": (1.0, 0.0, 0.12), "top": (0.0, -0.001, 1.0), "bottom": (0.0, 0.001, -1.0),
    "plan": (0.0, -0.0001, 1.0),
}


def scale_figure(x, y, z, height=1.8):
    """A plain 1.8 m person (capsule body, head) for judging scale in renders."""
    parts = []
    bm = bmesh.new()
    r = height * 0.13
    bmesh.ops.create_cone(bm, segments=16, radius1=r, radius2=r * 0.85, depth=height * 0.52,
                          matrix=mathutils.Matrix.Translation((0, 0, height * 0.52 / 2 + height * 0.3)), cap_ends=True)
    for sx in (-1, 1):
        bmesh.ops.create_cone(bm, segments=10, radius1=r * 0.38, radius2=r * 0.34, depth=height * 0.32,
                              matrix=mathutils.Matrix.Translation((sx * r * 0.5, 0, height * 0.16)), cap_ends=True)
    bmesh.ops.create_uvsphere(bm, u_segments=16, v_segments=10, radius=height * 0.075,
                              matrix=mathutils.Matrix.Translation((0, 0, height * 0.9)))
    me = bpy.data.meshes.new("_kiln_figure")
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new("_kiln_figure", me)
    ob.location = (x, y, z)
    mat = bpy.data.materials.new("_kiln_figure")
    mat.diffuse_color = (0.25, 0.45, 0.85, 1)
    p = principled(mat)
    if p:
        p.inputs["Base Color"].default_value = (0.25, 0.45, 0.85, 1)
    me.materials.append(mat)
    bpy.context.scene.collection.objects.link(ob)
    return ob, me, mat


def scale_ruler(x, y, z, length):
    """A ruler lying beside a small model: `length` long in ten alternating marks (a person would dwarf it)."""
    bm = bmesh.new()
    w, t = length * 0.14, length * 0.03
    for i in range(10):
        ret = bmesh.ops.create_cube(bm, size=1.0, matrix=mathutils.Matrix.Translation((0, (i + 0.5) * length / 10 - length / 2, t / 2)) @ mathutils.Matrix.Diagonal((w, length / 10, t, 1)))
        for f in {f for v in ret["verts"] for f in v.link_faces}:
            f.material_index = i % 2
    me = bpy.data.meshes.new("_kiln_ruler")
    bm.to_mesh(me)
    bm.free()
    mats = []
    for nm, col in (("_kiln_ruler_a", (0.9, 0.9, 0.9, 1)), ("_kiln_ruler_b", (0.1, 0.25, 0.7, 1))):
        m = bpy.data.materials.new(nm)
        m.diffuse_color = col
        p = principled(m)
        if p:
            p.inputs["Base Color"].default_value = col
        me.materials.append(m)
        mats.append(m)
    ob = bpy.data.objects.new("_kiln_ruler", me)
    ob.location = (x, y, z)
    bpy.context.scene.collection.objects.link(ob)
    return (ob, me, *mats)


def op_render(req):
    object_mode()
    scene = bpy.context.scene
    views = [v for v in (req.get("views") or ["iso"]) if v in VIEWS][:6] or ["iso"]
    pretty = req.get("quality") == "pretty"
    # "roblox": lit like the game's place, showing only what Roblox can show (see kiln_roblox.preview).
    roblox = pretty and req.get("lighting") == "roblox"
    stack = contextlib.ExitStack()
    width = max(256, min(1600, int(req.get("size", 768))))
    height = int(width * 0.75)
    focus = [bpy.data.objects[n] for n in (req.get("focus") or []) if n in bpy.data.objects]
    unknown = [n for n in (req.get("focus") or []) if n not in bpy.data.objects]
    # A group (a house or tree made by the kit is an empty with parts) frames all of its parts.
    focus = [o for f in focus for o in [f, *f.children_recursive] if o.type in MESHLIKE and o.visible_get()]
    targets = focus or [o for o in scene.objects if o.type in MESHLIKE and o.visible_get()]
    if not targets:
        return {"ok": False, "error": "Nothing visible to render (the scene has no visible geometry)."}
    lo, hi = [math.inf] * 3, [-math.inf] * 3
    bound_frames = [int(f) for f in (req.get("frame_bounds") or [])] or [None]
    here = scene.frame_current
    for bf in bound_frames:
        if bf is not None:
            scene.frame_set(bf)
        for ob in targets:
            for c in ob.bound_box:
                w = ob.matrix_world @ mathutils.Vector(c)
                for i in range(3):
                    lo[i], hi[i] = min(lo[i], w[i]), max(hi[i], w[i])
    if bound_frames != [None]:
        scene.frame_set(here)
    figure, figure_note = None, None
    # The floor goes under everything visible, not under the framed part (a lamp on a table isn't cut by a floor).
    floor_z = lo[2]
    for ob in scene.objects:
        if ob.type in MESHLIKE and ob.visible_get():
            floor_z = min(floor_z, min((ob.matrix_world @ mathutils.Vector(c)).z for c in ob.bound_box))
    if req.get("figure"):
        # A person beside the subject, framed with it: the size is obvious at a glance. (Other apps
        # working in other units pass the person's height in their units, e.g. 5.2 studs.)
        fh = float(req.get("figure_height") or 1.8)
        biggest = max(hi[i] - lo[i] for i in range(3))
        if biggest < 0.3 * fh:
            # Beside a small model a person is all you'd see: a ruler instead, one power of ten long.
            length = 10 ** math.floor(math.log10(max(biggest, 1e-6)))
            gap = max(length * 0.2, (hi[0] - lo[0]) * 0.1)
            figure = scale_ruler(hi[0] + gap + length * 0.07, (lo[1] + hi[1]) / 2, lo[2], length)
            hi[0] += gap + length * 0.14
            lo[1], hi[1] = min(lo[1], (lo[1] + hi[1]) / 2 - length / 2), max(hi[1], (lo[1] + hi[1]) / 2 + length / 2)
            figure_note = "a ruler %g long, each mark %g (the model is small; a person %g tall would dwarf it)" % (length, length / 10, fh)
        else:
            gap = max(0.22 * fh, (hi[0] - lo[0]) * 0.08)
            figure = scale_figure(hi[0] + gap, (lo[1] + hi[1]) / 2, lo[2], fh)
            hi[0] += gap + 0.17 * fh
            hi[2] = max(hi[2], lo[2] + fh)
            figure_note = "a person %g tall" % fh
    center = mathutils.Vector([(lo[i] + hi[i]) / 2 for i in range(3)])
    radius = max(0.05, (mathutils.Vector(hi) - mathutils.Vector(lo)).length / 2)

    r = scene.render
    sh = scene.display.shading
    saved = {"camera": scene.camera, "engine": r.engine, "x": r.resolution_x, "y": r.resolution_y,
             "pct": r.resolution_percentage, "path": r.filepath, "fmt": r.image_settings.file_format,
             "transparent": r.film_transparent, "world": scene.world, "frame": scene.frame_current,
             "taa": getattr(scene.eevee, "taa_render_samples", None),
             "shading": (sh.light, sh.color_type, sh.show_shadows, sh.show_cavity, sh.show_object_outline)}
    temp_objects, temp_data, synced, hidden = [], [], [], []
    floor = None
    if figure:
        temp_objects.append(figure[0])
        temp_data.extend(figure[1:])
    if req.get("isolate") and focus:
        # Only the focused objects: nothing else in front of them.
        for ob in scene.objects:
            if ob.type in MESHLIKE and ob not in targets and not ob.hide_render and not ob.name.startswith("_kiln"):
                ob.hide_render = True
                hidden.append(ob)
    tiles = []
    try:
        cam_data = bpy.data.cameras.new("_kiln_cam")
        cam_data.lens = 50
        cam = bpy.data.objects.new("_kiln_cam", cam_data)
        scene.collection.objects.link(cam)
        temp_objects.append(cam)
        temp_data.append(cam_data)
        scene.camera = cam
        r.resolution_x, r.resolution_y, r.resolution_percentage = width, height, 100
        r.image_settings.file_format = "PNG"
        r.film_transparent = bool(req.get("transparent"))
        if scene.world is None:
            world = bpy.data.worlds.new("_kiln_world")
            temp_data.append(world)
            scene.world = world
        if pretty:
            engine_set = False
            for name in ("BLENDER_EEVEE", "BLENDER_EEVEE_NEXT"):
                try:
                    r.engine = name
                    engine_set = True
                    break
                except TypeError:
                    continue
            if not engine_set:
                r.engine = "CYCLES"
            try:
                scene.eevee.taa_render_samples = 24
            except Exception:  # noqa: BLE001
                pass
            if roblox:
                stack.enter_context(kiln_roblox.preview(req.get("roblox_lighting"), honest=req.get("honest", True)))
            elif not any(o.type == "LIGHT" and o.visible_get() and not o.hide_render for o in scene.objects):
                sun_data = bpy.data.lights.new("_kiln_sun", "SUN")
                sun_data.energy = 3.5
                sun_data.angle = math.radians(8)
                sun = bpy.data.objects.new("_kiln_sun", sun_data)
                sun.rotation_euler = (math.radians(48), math.radians(8), math.radians(35))
                scene.collection.objects.link(sun)
                temp_objects.append(sun)
                temp_data.append(sun_data)
                if scene.world.name == "_kiln_world":
                    scene.world.color = (0.35, 0.37, 0.4)
            # A floor just under the geometry so objects don't float in the product shot.
            floor_me = bpy.data.meshes.new("_kiln_floor")
            s = radius * 6
            floor_me.from_pydata([(-s, -s, 0), (s, -s, 0), (s, s, 0), (-s, s, 0)], [], [(0, 1, 2, 3)])
            floor_mat = bpy.data.materials.new("_kiln_floor")
            floor_color = (0.125, 0.115, 0.122, 1) if roblox else (0.3, 0.31, 0.33, 1)  # roblox: a baseplate's dark stone grey
            floor_mat.diffuse_color = floor_color
            try:
                p = principled(floor_mat) or None
                if p:
                    p.inputs["Base Color"].default_value = floor_color
                    p.inputs["Roughness"].default_value = 0.9
            except Exception:  # noqa: BLE001
                pass
            floor_me.materials.append(floor_mat)
            floor = bpy.data.objects.new("_kiln_floor", floor_me)
            floor.location = (center.x, center.y, min(lo[2], floor_z) - 0.001)
            scene.collection.objects.link(floor)
            temp_objects.append(floor)
            temp_data.extend([floor_me, floor_mat])
        else:
            r.engine = "BLENDER_WORKBENCH"
            sh = scene.display.shading
            sh.light, sh.color_type = "STUDIO", "TEXTURE"  # image textures where there are some, else colors
            sh.show_shadows, sh.show_cavity, sh.show_object_outline = True, True, True
            if scene.world.name == "_kiln_world":
                scene.world.color = (0.2, 0.21, 0.23)
            # Workbench shows a material's viewport color, not its node color: sync them for the render.
            for m in bpy.data.materials:
                p = principled(m)
                if p and "Base Color" in p.inputs:
                    synced.append((m, tuple(m.diffuse_color), m.metallic, m.roughness))
                    m.diffuse_color = tuple(p.inputs["Base Color"].default_value)
                    m.metallic = float(p.inputs["Metallic"].default_value)
                    m.roughness = float(p.inputs["Roughness"].default_value)

        vfov = 2 * math.atan(math.tan(cam_data.angle / 2) * height / width)
        dist = radius / math.sin(min(cam_data.angle, vfov) / 2) * 0.94
        cam_data.clip_start = max(0.001, dist - radius * 2) * 0.5
        cam_data.clip_end = dist + radius * 4
        base = os.path.splitext(req["path"])[0]
        max_shots = max(1, min(12, int(req.get("max_shots") or 6)))
        frames = [int(f) for f in (req.get("frames") or [])][:max_shots]
        shots = [(f, v) for f in frames for v in views][:max_shots] if frames else [(None, v) for v in views]
        saved_frame = scene.frame_current
        for i, (f, v) in enumerate(shots):
            if f is not None:
                scene.frame_set(f)
            d = mathutils.Vector(VIEWS[v]).normalized()
            if v == "plan":
                # A true top-down map: orthographic, north (+Y) up, the whole footprint in frame.
                cam_data.type = "ORTHO"
                cam_data.ortho_scale = max(hi[0] - lo[0], (hi[1] - lo[1]) * width / height) * 1.08
                cam.location = (center.x, center.y, hi[2] + radius)
                cam.rotation_euler = (0, 0, 0)
                cam_data.clip_start, cam_data.clip_end = 0.01, radius * 4 + (hi[2] - lo[2])
            else:
                cam_data.type = "PERSP"
                cam.location = center + d * dist
                cam.rotation_euler = (-d).to_track_quat("-Z", "Y").to_euler()
                cam_data.clip_start = max(0.001, dist - radius * 2) * 0.5
                cam_data.clip_end = dist + radius * 4
            if floor is not None:
                floor.hide_render = v == "bottom"  # from below, a floor is all you would see
            tile = "%s_t%d.png" % (base, i) if len(shots) > 1 else req["path"]
            r.filepath = tile
            bpy.ops.render.render(write_still=True)
            tiles.append(tile)
        if frames:
            scene.frame_set(saved_frame)
        if len(shots) > 1 and not req.get("tiles_only"):
            contact_sheet(tiles, req["path"], width, height)
        views = ["frame %d %s" % (f, v) if f is not None else v for f, v in shots]
    finally:
        stack.close()
        for m, dc, me, ro in synced:
            m.diffuse_color, m.metallic, m.roughness = dc, me, ro
        for ob in hidden:
            ob.hide_render = False
        if scene.frame_current != saved["frame"]:
            scene.frame_set(saved["frame"])
        if saved["taa"] is not None:
            try:
                scene.eevee.taa_render_samples = saved["taa"]
            except Exception:  # noqa: BLE001
                pass
        sh.light, sh.color_type, sh.show_shadows, sh.show_cavity, sh.show_object_outline = saved["shading"]
        scene.camera = saved["camera"]
        r.engine, r.resolution_x, r.resolution_y = saved["engine"], saved["x"], saved["y"]
        r.resolution_percentage, r.filepath = saved["pct"], saved["path"]
        r.image_settings.file_format, r.film_transparent = saved["fmt"], saved["transparent"]
        scene.world = saved["world"]
        for ob in temp_objects:
            bpy.data.objects.remove(ob, do_unlink=True)
        for d in temp_data:
            try:
                if isinstance(d, bpy.types.Camera):
                    bpy.data.cameras.remove(d)
                elif isinstance(d, bpy.types.Light):
                    bpy.data.lights.remove(d)
                elif isinstance(d, bpy.types.World):
                    bpy.data.worlds.remove(d)
                elif isinstance(d, bpy.types.Mesh):
                    bpy.data.meshes.remove(d)
                elif isinstance(d, bpy.types.Material):
                    bpy.data.materials.remove(d)
            except Exception:  # noqa: BLE001
                pass
        if len(tiles) > 1 and not req.get("tiles_only"):
            for t in tiles:
                try:
                    os.remove(t)
                except OSError:
                    pass
    return {"path": req["path"], "views": views, "engine": "eevee" if pretty else "workbench", "tiles": tiles, "lighting": "roblox" if roblox else "scene",
            "figure": figure_note, "unknown_focus": unknown}


def contact_sheet(tiles, path, w, h, gap=6):
    cols = 1 if len(tiles) == 1 else 2 if len(tiles) <= 4 else 3
    rows = (len(tiles) + cols - 1) // cols
    W, H = cols * w + (cols - 1) * gap, rows * h + (rows - 1) * gap
    sheet = np.empty((H, W, 4), dtype=np.float32)
    sheet[:] = (0.07, 0.075, 0.085, 1.0)
    for i, t in enumerate(tiles):
        img = bpy.data.images.load(t)
        px = np.empty(w * h * 4, dtype=np.float32)
        img.pixels.foreach_get(px)
        bpy.data.images.remove(img)
        row, col = divmod(i, cols)
        y0 = (rows - 1 - row) * (h + gap)  # Blender images start at the bottom row
        x0 = col * (w + gap)
        sheet[y0:y0 + h, x0:x0 + w] = px.reshape(h, w, 4)
    out = bpy.data.images.new("_kiln_sheet", W, H, alpha=False)
    out.pixels.foreach_set(sheet.ravel())
    out.filepath_raw = path
    out.file_format = "PNG"
    out.save()
    bpy.data.images.remove(out)


def _fit(t, w, h):
    """Shrinks an (h, w, 4) pixel array to fit inside w x h (nearest sampling; tiles are already small)."""
    th, tw = t.shape[:2]
    s = min(1.0, w / tw, h / th)
    if s >= 1.0:
        return t
    nh, nw = max(1, int(th * s)), max(1, int(tw * s))
    ys = (np.arange(nh) / s).astype(int).clip(0, th - 1)
    xs = (np.arange(nw) / s).astype(int).clip(0, tw - 1)
    return t[ys][:, xs]


def op_refsheet(req):
    """Reference images (downloaded files) on one JPEG contact sheet, each fitted into its cell on a dark
    background, left to right then top to bottom. Files Blender can't read are skipped. The scene is
    not touched (the images are removed again)."""
    paths = req["paths"]
    n_max = len(paths)
    cols = 1 if n_max == 1 else 2 if n_max <= 4 else 3 if n_max <= 6 else 4
    cell = int(req.get("cell") or (560 if n_max <= 2 else 480 if n_max <= 4 else 400 if n_max <= 6 else 380))
    tiles, used = [], []
    for i, p in enumerate(paths):
        img = None
        try:
            img = bpy.data.images.load(p, check_existing=False)
            w, h = img.size
            if not w or not h:
                raise ValueError("empty image")
            s = min(cell / w, cell / h)
            nw, nh = max(1, int(w * s)), max(1, int(h * s))
            img.scale(nw, nh)
            px = np.empty(nw * nh * 4, dtype=np.float32)
            img.pixels.foreach_get(px)
            tiles.append(px.reshape(nh, nw, 4))
            used.append(i)
        except Exception:  # noqa: BLE001
            pass
        finally:
            if img is not None:
                bpy.data.images.remove(img)
    if not tiles:
        return {"ok": False, "error": "none of the images could be read"}
    n = len(tiles)
    cols = min(cols, n)
    rows = (n + cols - 1) // cols
    gap = 6
    # Cells shaped like the images (wide film stills get wide cells), so the sheet has little empty space.
    shape = sorted(t.shape[0] / t.shape[1] for t in tiles)[n // 2]
    cw, ch = cell, int(cell * min(1.0, max(0.5, shape)))
    tiles = [_fit(t, cw, ch) for t in tiles]
    W, H = cols * cw + (cols - 1) * gap, rows * ch + (rows - 1) * gap
    bg = np.array((0.07, 0.075, 0.085), dtype=np.float32)
    sheet = np.empty((H, W, 4), dtype=np.float32)
    sheet[:, :, :3] = bg
    sheet[:, :, 3] = 1.0
    for i, t in enumerate(tiles):
        th, tw = t.shape[:2]
        row, col = divmod(i, cols)
        y0 = (rows - 1 - row) * (ch + gap) + (ch - th) // 2  # Blender images start at the bottom row
        x0 = col * (cw + gap) + (cw - tw) // 2
        a = t[:, :, 3:4]
        sheet[y0:y0 + th, x0:x0 + tw, :3] = t[:, :, :3] * a + bg * (1 - a)
    out = bpy.data.images.new("_kiln_refs", W, H, alpha=False)
    out.pixels.foreach_set(sheet.ravel())
    out.filepath_raw = req["path"]
    out.file_format = "JPEG"
    try:
        out.save(quality=88)
    except TypeError:  # older Blender: no quality argument
        out.save()
    bpy.data.images.remove(out)
    return {"ok": True, "used": used, "size": [W, H], "cols": cols}


def op_motion(req):
    """A clip as images for the copilot: "strip" (labelled frames), "onion" (frames overlaid, early blue
    to late orange), "trails" (paths of feet, tail tip, head, root), "graph" (foot heights, planted
    frames, body height, events). Paths: <base>-<view>.png."""
    import motion_views as mv
    object_mode()
    clip = req.get("clip")
    rig = kiln.rig.armature(False)
    if rig is None:
        return {"ok": False, "error": "no rig in the scene"}
    cur = rig.animation_data.action.name if rig.animation_data and rig.animation_data.action else None
    clip = clip or cur
    if not clip:
        return {"ok": False, "error": "no clip given and none is showing"}
    scene = bpy.context.scene
    before = (scene.frame_start, scene.frame_end, scene.frame_current)
    kiln.anim.use(clip)
    base = req["base"]
    view = req.get("view") or "left"
    views = [v for v in (req.get("views") or ["strip", "graph"]) if v in ("strip", "onion", "trails", "graph")][:4]
    out, notes = [], []
    try:
        for v in views:
            p = "%s-%s.png" % (base, v)
            if v == "strip":
                path, frames = mv.strip(op_render, kiln.anim, clip, p, count=int(req.get("count") or 8), view=view, size=int(req.get("size") or 360))
                notes.append("strip frames " + ", ".join(str(f) for f in frames))
            elif v == "onion":
                path, frames = mv.onion(op_render, kiln.anim, clip, p, count=min(10, int(req.get("count") or 6)), view=view, size=int(req.get("size") or 720))
                notes.append("onion frames " + ", ".join(str(f) for f in frames))
            elif v == "trails":
                path, labels = mv.trails(op_render, kiln.anim, clip, p, view=req.get("trail_view") or "iso", size=int(req.get("size") or 720))
                notes.append("trails: " + ", ".join(labels))
            else:
                path, gnotes = mv.graph(kiln.anim, clip, p)
                notes += gnotes
            out.append({"view": v, "path": path})
    finally:
        # Looking at a clip must not change the scene (a changed scene is saved as a new version).
        if cur and bpy.data.actions.get(cur):
            if cur != clip:
                kiln.anim.use(cur)
        elif not cur and rig.animation_data is not None:
            rig.animation_data.action = None
            for pb in rig.pose.bones:
                pb.matrix_basis.identity()
        scene.frame_start, scene.frame_end = before[0], before[1]
        scene.frame_set(before[2])
    return {"ok": True, "clip": clip, "images": out, "notes": notes}


def op_clips_export(req):
    """All clips sampled to JSON for the live viewer (see kiln_anim.export_json)."""
    if kiln.rig.armature(False) is None:
        return {"ok": True, "clips": 0}
    r = kiln.anim.export_json(req["path"], fps=int(req.get("fps") or 30))
    return dict(r, ok=True)


def op_anim_check(req):
    """kiln.anim.check on a clip (read only)."""
    if kiln.rig.armature(False) is None:
        return {"ok": False, "error": "no rig in the scene"}
    return {"ok": True, "report": kiln.anim.check(req["clip"])}


def op_rig(req):
    """The rig and its clips as data (the Animate panel, other apps), with the rig check."""
    has = kiln.rig.armature(False) is not None
    return {"ok": True, "info": kiln.rig.info(), "clips": kiln.anim.clips() if has else [], "check": kiln.rig.check()}


_ext_mtimes = {}


def op_ext(req):
    """Runs `func(**args)` from `module` in folder `dir` (another app's Blender code, e.g. Shuriken's Roblox
    export) against this scene. The module is reloaded when its file changed. Returns its dict, plus the
    scene fingerprint so a change is saved like any other."""
    import importlib
    d, name = req["dir"], req["module"]
    if d not in sys.path:
        sys.path.insert(0, d)
    path = os.path.join(d, name + ".py")
    mtime = os.path.getmtime(path) if os.path.exists(path) else 0
    mod = sys.modules.get(name)
    if mod is None:
        mod = importlib.import_module(name)
    elif _ext_mtimes.get(name) != mtime:
        mod = importlib.reload(mod)
    _ext_mtimes[name] = mtime
    object_mode()
    res = getattr(mod, req.get("func") or "run")(**(req.get("args") or {}))
    out = dict(res) if isinstance(res, dict) else {"result": res}
    summary, fp = scan()
    out.setdefault("summary", summary)
    out["fingerprint"] = fp
    return out


OPS = {"ext": op_ext, "ping": op_ping, "new": op_new, "open": op_open, "exec": op_exec, "scene": op_scene,
       "save": op_save, "export": op_export, "render": op_render, "check": op_check, "refsheet": op_refsheet,
       "motion": op_motion, "clips_export": op_clips_export, "rig": op_rig, "anim_check": op_anim_check,
       "roblox_check": op_roblox_check, "parts": op_parts}


def main():
    quiet_prefs()
    fresh_namespace()
    reply({"event": "ready", "version": bpy.app.version_string, "python": sys.version.split()[0]})
    while True:
        line = sys.stdin.readline()
        if not line:
            break  # the server closed the pipe: quit Blender
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except ValueError:
            continue
        t0 = time.time()
        try:
            fn = OPS.get(req.get("op"))
            res = fn(req) if fn else {"ok": False, "error": "unknown op %r" % req.get("op")}
        except Exception:  # noqa: BLE001
            res = {"ok": False, "error": traceback.format_exc(limit=4)[-2500:]}
        res.setdefault("ok", True)
        res["id"] = req.get("id")
        res["ms"] = int((time.time() - t0) * 1000)
        reply(res)


main()
