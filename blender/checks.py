"""
Scene checks for Kiln: z-fighting (surfaces that will flicker), objects floating with nothing under them,
objects entirely below the ground. Vectorized with numpy so a few hundred thousand triangles take well
under a second.

Z-fighting: two surfaces facing the same way that overlap and lie in, or close to, the same plane. The depth
buffer can't tell which one is in front, so they flicker as the camera moves. It is found between separate
objects and inside one mesh, for exactly flush surfaces and for layers closer than the safe gap of
zfight_rule (a plate 2 mm off a wall flickers in Roblox at game distances). Surfaces facing opposite ways
(a crate on the floor, two boxes stacked) are contact, not z-fighting: the hidden one faces away.
"""

import time

import bmesh
import bpy
import mathutils
import numpy as np
from mathutils.bvhtree import BVHTree

MESHLIKE = {"MESH", "CURVE", "SURFACE", "META", "FONT"}
# What the bridge knows about the project, set on every request: its units ("m" | "studs") and whether the
# model goes into a Roblox game.
CONTEXT = {"units": "m", "roblox": False}
_Q = 60  # normal buckets: about 1° wide


def zfight_rule(units=None, roblox=None):
    """The safe distance between two overlapping layers facing the same way, in scene units:
    (base, per_width, cap, flush). A layer `w` wide needs min(max(base, per_width * w), cap) and never more
    than a tenth of its own width; closer than `flush` counts as flush (exactly coplanar).

    Why these numbers. Roblox on PC and iOS uses a reversed-Z floating-point depth buffer, where 0.02 studs
    never flickers at any game distance. The weak case is Android (GLES-class) GPUs with a 24-bit depth
    buffer and Roblox's 0.1-stud near plane: one depth step at distance z is z^2 / (0.1 * 2^24) studs
    (0.0015 at 50 studs, 0.006 at 100, 0.024 at 200). With a 4x margin for slopes and interpolation,
    0.02 studs (5.6 mm) holds to about 90 studs: as far as a small detail still covers a few pixels on a
    phone. A big layer (a road on the ground, a sign on a wall) stays visible much further, so its gap grows
    with its width: 0.4% of it (0.04 studs at 10 studs wide), at most 0.1 studs. Roblox projects in metres
    use the same rule (1 stud = 0.28 m). Other targets: 2 mm, 0.2% of the width, at most 1 cm (desktop
    engines use reversed-Z float depth; Kiln's viewer a logarithmic one)."""
    units = units or CONTEXT.get("units") or "m"
    roblox = bool(CONTEXT.get("roblox")) if roblox is None else bool(roblox)
    if units == "studs":
        return 0.02, 0.004, 0.1, 0.002
    if roblox:
        return 0.0056, 0.004, 0.028, 0.0005
    return 0.002, 0.002, 0.01, 0.0005


def _need(rule, width):
    base, per_width, cap, flush = rule
    return float(min(max(base, per_width * width), cap, max(0.1 * width, 2 * flush)))


def _visible_meshes(obs=None):
    pool = bpy.context.scene.objects if obs is None else obs
    return [ob for ob in pool if ob.type in MESHLIKE and ob.visible_get() and ob.get("kiln_role") != "collider"]


def _evaluated(ob, dg):
    """World vertices, triangles (vertex indices) and each triangle's polygon index of an object as shown."""
    ev = ob.evaluated_get(dg)
    try:
        me = ev.to_mesh()
    except Exception:  # noqa: BLE001
        return None
    if me is None:
        return None
    me.calc_loop_triangles()
    nv, nt = len(me.vertices), len(me.loop_triangles)
    if not nv or not nt:
        ev.to_mesh_clear()
        return None
    co = np.empty(nv * 3, dtype=np.float32)
    me.vertices.foreach_get("co", co)
    tri = np.empty(nt * 3, dtype=np.int32)
    me.loop_triangles.foreach_get("vertices", tri)
    poly = np.empty(nt, dtype=np.int32)
    me.loop_triangles.foreach_get("polygon_index", poly)
    ev.to_mesh_clear()
    m = np.array(ob.matrix_world, dtype=np.float64)
    w = co.reshape(-1, 3).astype(np.float64) @ m[:3, :3].T + m[:3, 3]
    return w, tri.reshape(-1, 3), poly


def _world_triangles(ob, dg):
    r = _evaluated(ob, dg)
    return (None, None) if r is None else (r[0], r[1])


def _gap(name, others, geo, trees, deadline):
    """The smallest distance between an object's surface and its neighbours' (sampled both ways), or
    None when it can't be measured (a neighbour too heavy to index, or out of time)."""
    def tree(n):
        if n not in trees:
            w, tri = geo[n]
            trees[n] = BVHTree.FromPolygons(w.tolist(), tri.tolist())
        return trees[n]

    def sample(n, k=160):
        w = geo[n][0]
        return w[:: max(1, len(w) // k)]

    best = None
    for o in others[:24]:
        if o not in geo or time.time() > deadline:
            return None
        # Surfaces that cut through each other touch, wherever their vertices happen to be (a post sunk
        # into a hull has its end deep inside: measuring from vertices alone called it "not touching").
        if tree(name).overlap(tree(o)):
            return 0.0
        for src, dst in ((name, o), (o, name)):
            t = tree(dst)
            for p in sample(src):
                hit = t.find_nearest(mathutils.Vector(p), best if best is not None else 1e9)
                if hit[3] is not None and (best is None or hit[3] < best):
                    best = hit[3]
                    if best < 1e-4:
                        return best
    return best


def _sat_overlap(a, b, eps):
    """For triangle pairs a, b (k, 3, 2): True where their interiors overlap by more than eps."""
    ok = np.ones(len(a), dtype=bool)
    for tri in (a, b):
        for i in range(3):
            e = tri[:, (i + 1) % 3] - tri[:, i]
            axis = np.stack([-e[:, 1], e[:, 0]], axis=1)
            ln = np.linalg.norm(axis, axis=1, keepdims=True)
            axis = axis / np.maximum(ln, 1e-12)
            pa = np.einsum("kij,kj->ki", a, axis)
            pb = np.einsum("kij,kj->ki", b, axis)
            overlap = np.minimum(pa.max(1), pb.max(1)) - np.maximum(pa.min(1), pb.min(1))
            ok &= overlap > eps
    return ok


def _plane_sep(P, N, ci, cj):
    """How far triangle j's corners stay from triangle i's plane (0 when they cross it), per pair."""
    out = np.empty(len(ci))
    for s in range(0, len(ci), 500_000):
        a, b = ci[s : s + 500_000], cj[s : s + 500_000]
        d = np.einsum("kvj,kj->kv", P[b], N[a]) - np.einsum("kj,kj->k", P[a][:, 0], N[a])[:, None]
        lo, hi = d.min(1), d.max(1)
        out[s : s + 500_000] = np.where(lo > 0, lo, np.where(hi < 0, -hi, 0.0))
    return out


def _pairs_in_runs(starts, ends, cap):
    """All index pairs (p, q), p < q, inside each run [start, end) of a sorted array. Runs longer than
    `cap` entries are cut to their first `cap` (pathological stacks of identical copies)."""
    ends = np.minimum(ends, starts + cap)
    lens = ends - starts
    keep = lens >= 2
    starts, ends, lens = starts[keep], ends[keep], lens[keep]
    if not len(starts):
        return np.empty(0, np.int64), np.empty(0, np.int64)
    pos = np.concatenate([np.arange(s, e - 1) for s, e in zip(starts.tolist(), ends.tolist())]) if len(starts) < 2000 else None
    if pos is None:
        # Vectorized: every position of every run except the last one, with the end of its run.
        run_of = np.repeat(np.arange(len(starts)), lens - 1)
        pos = starts[run_of] + (np.arange(len(run_of)) - np.repeat(np.cumsum(lens - 1) - (lens - 1), lens - 1))
        run_end = ends[run_of]
    else:
        run_end = np.repeat(ends, lens - 1)
    counts = run_end - pos - 1
    total = int(counts.sum())
    if total <= 0:
        return np.empty(0, np.int64), np.empty(0, np.int64)
    p = np.repeat(pos, counts)
    q = p + 1 + (np.arange(total) - np.repeat(np.cumsum(counts) - counts, counts))
    return p, q


def find_zfight(obs=None, rule=None, max_tris=800000, time_limit=4.0, _items=None):
    """Surfaces that will z-fight: overlapping, facing the same way, closer than the safe gap. Returns
    (findings, detail): findings = [{a, b, inside, faces, sep, gap, kind, where, normal, front}] (b == a and
    inside true for two layers inside one mesh), most faces first; detail = what a fix needs."""
    rule = rule or zfight_rule()
    base, per_width, cap, flush = rule
    if _items is None:
        dg = bpy.context.evaluated_depsgraph_get()
        _items = []
        for ob in _visible_meshes(obs):
            r = _evaluated(ob, dg)
            if r is not None:
                _items.append((ob.name, r[0], r[1], r[2]))
    deadline = time.time() + time_limit
    names, P, OBJ, POLY, VID = [], [], [], [], []
    total = voff = 0
    for name, w, tri, poly in _items:
        if total >= max_tris:
            break
        tri, poly = tri[: max_tris - total], poly[: max_tris - total]
        total += len(tri)
        k = len(names)
        names.append(name)
        P.append(w[tri])
        OBJ.append(np.full(len(tri), k, dtype=np.int32))
        POLY.append(poly)
        VID.append(tri.astype(np.int64) + voff)
        voff += len(w)
    empty = ([], {"names": names, "truncated": False, "checked": int(total)})
    if not P:
        return empty
    P, OBJ, POLY, VID = np.concatenate(P), np.concatenate(OBJ), np.concatenate(POLY), np.concatenate(VID)
    N = np.cross(P[:, 1] - P[:, 0], P[:, 2] - P[:, 0])
    a2 = np.linalg.norm(N, axis=1)
    keep = a2 > 1e-12
    idx = np.flatnonzero(keep)
    P, OBJ, POLY, VID, N, area = P[keep], OBJ[keep], POLY[keep], VID[keep], N[keep] / a2[keep, None], a2[keep] / 2
    T = len(P)
    if T < 2:
        return empty
    eps = max(1e-5, flush * 0.05)
    band = cap
    hit_i, hit_j, hit_s = [], [], []
    truncated = False
    # Two passes with buckets shifted by half a bucket, so two nearly parallel normals share a bucket in at
    # least one. The first pass (centred on whole multiples: walls and floors sit mid-bucket) takes every
    # triangle; the second only those near an edge of a first-pass bucket, which are the only ones it can add.
    frac = N * _Q + 0.5
    frac -= np.floor(frac)
    near_edge = ((frac < 0.2) | (frac > 0.8)).any(axis=1)
    for off in (0.5, 0.0):
        if time.time() > deadline:
            truncated = True
            break
        if off == 0.0 and not near_edge.any():
            break
        qi = np.floor(N * _Q + off).astype(np.int64)
        key = ((qi[:, 0] + 64) * 128 + (qi[:, 1] + 64)) * 128 + (qi[:, 2] + 64)
        nq = (qi + 0.5 - off) / _Q
        nq /= np.linalg.norm(nq, axis=1, keepdims=True)
        helper = np.where(np.abs(nq[:, :1]) < 0.9, np.array([[1.0, 0.0, 0.0]]), np.array([[0.0, 1.0, 0.0]]))
        u = np.cross(nq, helper)
        u /= np.linalg.norm(u, axis=1, keepdims=True)
        v = np.cross(nq, u)
        pu = np.einsum("tij,tj->ti", P, u)
        pv = np.einsum("tij,tj->ti", P, v)
        pd = np.einsum("tij,tj->ti", P, nq)
        umin, umax, vmin, vmax, dmin, dmax = pu.min(1), pu.max(1), pv.min(1), pv.max(1), pd.min(1), pd.max(1)
        ext = np.maximum(umax - umin, vmax - vmin)
        h = max(float(np.median(ext)) * 1.5, 1e-4)
        # Only buckets with more than one triangle can hold a pair.
        order_k = np.argsort(key, kind="stable")
        ks = key[order_k]
        kstart = np.searchsorted(ks, ks, side="left")
        kend = np.searchsorted(ks, ks, side="right")
        multi = np.zeros(T, dtype=bool)
        multi[order_k] = (kend - kstart) > 1
        if off == 0.0:
            multi &= near_edge
        cd0 = np.floor(dmin / band).astype(np.int64)
        nd = np.floor((dmax + band) / band).astype(np.int64) - cd0 + 1

        def cells_at(hh):
            cu0, cv0 = np.floor(umin / hh).astype(np.int64), np.floor(vmin / hh).astype(np.int64)
            nu = np.floor(umax / hh).astype(np.int64) - cu0 + 1
            nv = np.floor(vmax / hh).astype(np.int64) - cv0 + 1
            return cu0, cv0, nu, nv, nu * nv * nd

        def grid(sel, at):
            """Each selected triangle in every (bucket, u, v, d) cell it covers, sorted into runs of one cell:
            the triangle of each entry, and each entry's run start and end."""
            cu0, cv0, nu, nv, cells = at
            cnt = cells[sel]
            tri_e = np.repeat(sel, cnt)
            loc = np.arange(len(tri_e)) - np.repeat(np.cumsum(cnt) - cnt, cnt)
            ndr, nvr = nd[tri_e], nv[tri_e]
            c = loc % ndr
            t = loc // ndr
            ecu, ecv, ecd = cu0[tri_e] + t // nvr, cv0[tri_e] + t % nvr, cd0[tri_e] + c
            # One int64 per cell (exact when the ranges fit, else a hash: a collision only adds candidates).
            su, sv, sd = (int(x.max() - x.min()) + 1 if len(x) else 1 for x in (ecu, ecv, ecd))
            if su * sv * sd < 2**41:
                cell = ((key[tri_e] * su + (ecu - ecu.min())) * sv + (ecv - ecv.min())) * sd + (ecd - ecd.min())
            else:
                cell = key[tri_e] * np.int64(73856093) ^ ecu * np.int64(19349663) ^ ecv * np.int64(83492791) ^ ecd * np.int64(2654435761)
            order = np.argsort(cell)
            cell, ecu, ecv, ecd, tri_e = cell[order], ecu[order], ecv[order], ecd[order], tri_e[order]
            brk = np.ones(len(order), dtype=bool)
            brk[1:] = cell[1:] != cell[:-1]
            st = np.flatnonzero(brk)
            en = np.append(st[1:], len(order))
            rid = np.cumsum(brk) - 1
            return tri_e, st, en, rid, (ecu, ecv, ecd), (cu0, cv0)

        def first_cell(p, q, tri_e, ec, c0):
            """A pair is kept only in the first cell both triangles cover: no duplicates to remove later."""
            ecu, ecv, ecd = ec
            cu0, cv0 = c0
            i, j = tri_e[p], tri_e[q]
            return (ecu[p] == np.maximum(cu0[i], cu0[j])) & (ecv[p] == np.maximum(cv0[i], cv0[j])) & (ecd[p] == np.maximum(cd0[i], cd0[j]))

        for _attempt in range(5):
            fine = cells_at(h)
            small = multi & (fine[4] <= 64)
            if int(fine[4][small].sum()) <= 6_000_000:
                break
            h *= 2.0
        big = multi & ~small
        cand_i, cand_j = [], []
        sidx = np.flatnonzero(small)
        if len(sidx):
            tri_e, st, en, _rid, ec, c0 = grid(sidx, fine)
            p, q = _pairs_in_runs(st, en, 160)
            if len(p) > 8_000_000:
                truncated = True
                pick = np.linspace(0, len(p) - 1, 8_000_000).astype(np.int64)
                p, q = p[pick], q[pick]
            first = first_cell(p, q, tri_e, ec, c0)
            cand_i.append(tri_e[p[first]])
            cand_j.append(tri_e[q[first]])
        huge = np.empty(0, dtype=np.int64)
        if big.any():
            # Big triangles (a wall, a ground plane) on a coarser grid, against everything in their cells.
            h2 = max(float(np.median(ext[big])) * 1.5, h * 8)
            coarse = cells_at(h2)
            huge = np.flatnonzero(big & (coarse[4] > 4096))
            sel2 = np.flatnonzero(multi & ~(big & (coarse[4] > 4096)))
            tri_e, st, en, rid, ec, c0 = grid(sel2, coarse)
            pos_b = np.flatnonzero(big[tri_e])
            if len(pos_b):
                s_b, e_b = st[rid[pos_b]], en[rid[pos_b]]
                cnt = e_b - s_b
                if int(cnt.sum()) > 8_000_000:
                    truncated = True
                    keep_b = np.cumsum(cnt) <= 8_000_000
                    pos_b, s_b, cnt = pos_b[keep_b], s_b[keep_b], cnt[keep_b]
                p = np.repeat(pos_b, cnt)
                q = np.repeat(s_b, cnt) + (np.arange(int(cnt.sum())) - np.repeat(np.cumsum(cnt) - cnt, cnt))
                # Big against small once; big against big once (the lower index of the two asks).
                ti, tj = tri_e[p], tri_e[q]
                other = (q != p) & (~big[tj] | (ti < tj)) & first_cell(p, q, tri_e, ec, c0)
                cand_i.append(ti[other])
                cand_j.append(tj[other])
        bidx = huge
        if len(bidx):
            is_huge = np.zeros(T, dtype=bool)
            is_huge[huge] = True
            if len(bidx) > 500:
                truncated = True
                bidx = bidx[np.argsort(-area[bidx])[:500]]
            for bt in bidx.tolist():
                if time.time() > deadline:
                    truncated = True
                    break
                lo = np.searchsorted(ks, key[bt], side="left")
                hi = np.searchsorted(ks, key[bt], side="right")
                m = order_k[lo:hi]
                m = m[(m != bt) & (~is_huge[m] | (m > bt)) & (umin[m] < umax[bt]) & (umin[bt] < umax[m]) & (vmin[m] < vmax[bt]) & (vmin[bt] < vmax[m]) & (dmin[m] < dmax[bt] + band) & (dmin[bt] < dmax[m] + band)]
                if len(m):
                    cand_i.append(np.full(len(m), bt, dtype=np.int64))
                    cand_j.append(m.astype(np.int64))
        if not cand_i:
            continue
        ci, cj = np.concatenate(cand_i), np.concatenate(cand_j)
        ci, cj = ci[ci != cj], cj[ci != cj]
        # Cheap filters first (the bucket's normal only bounds the distance from below), then the exact ones.
        sep = np.maximum(0.0, np.maximum(dmin[ci], dmin[cj]) - np.minimum(dmax[ci], dmax[cj]))
        ok = (sep <= band) & (umin[ci] < umax[cj] - eps) & (umin[cj] < umax[ci] - eps) & (vmin[ci] < vmax[cj] - eps) & (vmin[cj] < vmax[ci] - eps)
        ci, cj = ci[ok], cj[ok]
        # Neighbours across an edge of one mesh never overlap inside.
        shared = (VID[ci][:, :, None] == VID[cj][:, None, :]).sum(axis=(1, 2))
        ci, cj = ci[shared < 2], cj[shared < 2]
        if not len(ci):
            continue
        sep = np.maximum(_plane_sep(P, N, ci, cj), _plane_sep(P, N, cj, ci))
        ok = sep <= band
        ci, cj, sep = ci[ok], cj[ok], sep[ok]
        if not len(ci):
            continue
        hit = np.zeros(len(ci), dtype=bool)
        for s in range(0, len(ci), 400_000):
            e = s + 400_000
            a2d = np.stack([pu[ci[s:e]], pv[ci[s:e]]], axis=2)
            b2d = np.stack([pu[cj[s:e]], pv[cj[s:e]]], axis=2)
            hit[s:e] = _sat_overlap(a2d, b2d, eps)
        hit_i.append(ci[hit])
        hit_j.append(cj[hit])
        hit_s.append(sep[hit])
    if not hit_i:
        return [], {"names": names, "truncated": truncated, "checked": int(total)}
    hi_, hj_, hs_ = np.concatenate(hit_i), np.concatenate(hit_j), np.concatenate(hit_s)
    code = hi_ * T + hj_
    order = np.lexsort((hs_, code))
    code, hi_, hj_, hs_ = code[order], hi_[order], hj_[order], hs_[order]
    first = np.ones(len(code), dtype=bool)
    first[1:] = code[1:] != code[:-1]
    hi_, hj_, hs_ = hi_[first], hj_[first], hs_[first]
    # Which of the two is in front (along its own normal), so a fix knows which way to move.
    cen = P.mean(axis=1)
    i_front = np.einsum("ij,ij->i", N[hi_], cen[hi_] - cen[hj_]) >= 0
    front = np.where(i_front, hi_, hj_)
    back = np.where(i_front, hj_, hi_)
    oa, ob = OBJ[hi_], OBJ[hj_]
    g = np.minimum(oa, ob).astype(np.int64) * (len(names) + 1) + np.maximum(oa, ob)
    findings, detail_pairs = [], []
    for gid in np.unique(g)[:600].tolist():
        sel = np.flatnonzero(g == gid)
        # How wide the layer is: the smaller side's overlapping area (between objects, each object's own triangles).
        if oa[sel[0]] == ob[sel[0]]:
            sides = (np.unique(front[sel]), np.unique(back[sel]))
        else:
            both = np.unique(np.concatenate([hi_[sel], hj_[sel]]))
            sides = (both[OBJ[both] == oa[sel[0]]], both[OBJ[both] == ob[sel[0]]])
        width = float(np.sqrt(max(min(area[sides[0]].sum(), area[sides[1]].sum()), 1e-12)))
        need = _need(rule, width)
        sel = sel[hs_[sel] < need]
        if not len(sel):
            continue
        k = sel[np.argmin(hs_[sel])]
        na, nb = names[int(min(oa[k], ob[k]))], names[int(max(oa[k], ob[k]))]
        f = {
            "a": na, "b": nb, "inside": na == nb, "faces": int(len(sel)), "sep": round(float(hs_[k]), 6), "gap": round(need, 6),
            "kind": "flush" if hs_[k] <= flush else "layer", "where": [round(float(x), 3) for x in cen[front[k]]],
            "normal": [round(float(x), 3) for x in N[front[k]]], "front": names[int(OBJ[front[k]])], "width": round(width, 4),
        }
        findings.append(f)
        detail_pairs.append({"finding": f, "front": front[sel], "back": back[sel], "sep": hs_[sel]})
    findings.sort(key=lambda x: -x["faces"])
    return findings, {"names": names, "truncated": truncated, "checked": int(total), "pairs": detail_pairs, "OBJ": OBJ, "POLY": POLY, "N": N, "P": P, "idx": idx, "rule": rule}


# --- fixing ------------------------------------------------------------------------------------------

def _plain_mesh(ob):
    """A mesh whose shown faces are its own (no modifiers changing them) and used by this object only."""
    return ob.type == "MESH" and ob.data.users == 1 and not any(m.show_viewport for m in ob.modifiers) and not (ob.data.shape_keys and len(ob.data.shape_keys.key_blocks) > 1)


def _vol(ob):
    d = ob.dimensions
    return max(d.x, 1e-4) * max(d.y, 1e-4) * max(d.z, 1e-4)


def _move_polys(ob, polys, delta_world):
    """Moves the vertices of these polygons (an extrude or a lift of that face region) by a world vector."""
    me = ob.data
    inv = ob.matrix_world.to_3x3().inverted_safe()
    d = inv @ mathutils.Vector(delta_world)
    verts = set()
    for pi in polys:
        if 0 <= pi < len(me.polygons):
            verts.update(me.polygons[pi].vertices)
    for vi in verts:
        me.vertices[vi].co += d
    me.update()
    return len(verts)


def _coplanar_region(ob, poly_ids, normal_world, tol):
    """The polygons of the object lying in the plane of these ones (its whole flat face there, not only the
    overlapping triangles)."""
    me = ob.data
    mw = ob.matrix_world
    n3 = mw.to_3x3().inverted_safe().transposed()
    nw = mathutils.Vector(normal_world).normalized()
    ds = []
    for pi in poly_ids:
        if 0 <= pi < len(me.polygons):
            ds.append(nw.dot(mw @ me.polygons[pi].center))
    if not ds:
        return set(poly_ids)
    lo, hi = min(ds) - tol, max(ds) + tol
    out = set()
    for p in me.polygons:
        pn = (n3 @ p.normal).normalized()
        if pn.dot(nw) > 0.9998 and lo <= nw.dot(mw @ p.center) <= hi:
            out.add(p.index)
    return out | set(poly_ids)


def _loose_part(me, poly):
    """The polygons connected to this one (its loose part inside the mesh)."""
    v2p = {}
    for p in me.polygons:
        for v in p.vertices:
            v2p.setdefault(v, []).append(p.index)
    seen, stack = {poly}, [poly]
    while stack:
        for v in me.polygons[stack.pop()].vertices:
            for q in v2p.get(v, ()):
                if q not in seen:
                    seen.add(q)
                    stack.append(q)
    return seen


def _drop_duplicate_faces(ob, tol):
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    before = len(bm.faces)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=tol)
    seen, dupes = {}, []
    for f in bm.faces:
        k = tuple(sorted(v.index for v in f.verts))
        if k in seen:
            dupes.append(f)
        else:
            seen[k] = f
    if dupes:
        bmesh.ops.delete(bm, geom=dupes, context="FACES_ONLY")
    removed = before - len(bm.faces)
    if removed:
        bm.to_mesh(ob.data)
        ob.data.update()
    bm.free()
    return removed


def fix_zfight(findings, detail):
    """Moves layers apart so each pair is at least its safe gap apart, or removes duplicate faces. Between
    objects, the smaller one moves: when its face is in front (or flush) that face region is pushed out
    along its normal (an extrude: a plate gets thicker, a decal or road lifts off), when it is behind, the
    whole object sinks further in. Inside one mesh: duplicate faces are deleted; a loose part layered on
    the rest is moved; anything else is left for a hand fix. Returns what was done."""
    if not findings:
        return []
    base, per_width, cap, flush = detail["rule"]
    POLY = detail["POLY"]
    done, out = set(), []
    for pr in detail.get("pairs", []):
        f = pr["finding"]
        obA, obB = bpy.data.objects.get(f["a"]), bpy.data.objects.get(f["b"])
        if obA is None or obB is None:
            continue
        n = mathutils.Vector(f["normal"]).normalized()
        amount = f["gap"] - f["sep"] + base * 0.1
        if f["inside"]:
            ob = obA
            if ob.name in done or not _plain_mesh(ob):
                out.append({"object": ob.name, "inside": True, "action": "left for a hand fix" + ("" if _plain_mesh(ob) else " (its faces come from modifiers or a shared mesh)")})
                continue
            if f["kind"] == "flush":
                n_del = _drop_duplicate_faces(ob, max(1e-6, flush * 0.02))
                if n_del:
                    done.add(ob.name)
                    out.append({"object": ob.name, "inside": True, "action": f"removed {n_del} duplicate face(s)"})
                    continue
            fp = sorted(set(POLY[pr["front"]].tolist()))
            bp = sorted(set(POLY[pr["back"]].tolist()))
            part_f = _loose_part(ob.data, fp[0])
            part_b = _loose_part(ob.data, bp[0])
            if part_f & part_b or not set(fp) <= part_f or not set(bp) <= part_b:
                out.append({"object": ob.name, "inside": True, "action": "left for a hand fix (the layers are one connected surface)"})
                continue
            if len(part_f) <= len(part_b):
                k = _move_polys(ob, part_f, n * amount)
                out.append({"object": ob.name, "inside": True, "action": f"lifted a loose part ({k} vertices) {_fmt(amount)} out"})
            else:
                k = _move_polys(ob, part_b, -n * amount)
                out.append({"object": ob.name, "inside": True, "action": f"sank a loose part ({k} vertices) {_fmt(amount)} in"})
            done.add(ob.name)
            continue
        small, other = (obA, obB) if _vol(obA) <= _vol(obB) else (obB, obA)
        if small.get("kiln_ground") and not other.get("kiln_ground"):
            small, other = other, small  # the ground stays where it is
        if small.name in done:
            continue
        in_front = f["kind"] == "flush" or f["front"] == small.name
        if in_front and _plain_mesh(small):
            tris = np.concatenate([pr["front"], pr["back"]])
            mine = tris[detail["OBJ"][tris] == detail["names"].index(small.name)]
            polys = sorted(set(POLY[mine].tolist()))
            region = _coplanar_region(small, polys, n, max(flush, f["sep"] + flush))
            k = _move_polys(small, region, n * amount)
            out.append({"object": small.name, "from": other.name, "action": f"pushed its face out {_fmt(amount)} ({k} vertices)", "by": round(amount, 6), "direction": [round(x, 3) for x in n]})
        else:
            d = n * amount if in_front else -n * amount
            small.matrix_world.translation += d
            out.append({"object": small.name, "from": other.name, "action": f"moved {_fmt(amount)} {'out' if in_front else 'in'}", "by": round(amount, 6), "direction": [round(x, 3) for x in (n if in_front else -n)]})
        done.add(small.name)
    bpy.context.view_layer.update()
    return out


def _fmt(v):
    if (CONTEXT.get("units") or "m") == "studs":
        return f"{v:.3f} studs"
    return f"{v * 1000:.1f} mm"


def zfight(objs=None, fix=False):
    """Z-fighting check for the copilot's own scripts: surfaces that will flicker (overlapping, facing the
    same way, flush or closer than the safe gap), between the objects and inside each one. objs: objects,
    names, a collection, or empties holding parts (default: every visible mesh). fix=True moves layers
    apart (see fix_zfight) and reports what is left. Returns text."""
    obs = None
    if objs is not None:
        if isinstance(objs, bpy.types.Collection):
            items = list(objs.all_objects)
        else:
            items = [bpy.data.objects.get(o) if isinstance(o, str) else o for o in (objs if isinstance(objs, (list, tuple, set)) else [objs])]
        obs, seen = [], set()
        for o in items:
            if o is None:
                continue
            for x in [o] + list(o.children_recursive):
                if x.name not in seen:
                    seen.add(x.name)
                    obs.append(x)
    rule = zfight_rule()
    found, detail = find_zfight(obs, rule)
    lines = []
    if fix and found:
        for m in fix_zfight(found, detail):
            lines.append(f"fixed: {m['object']}: {m['action']}")
        found, detail = find_zfight(obs, rule)
    head = f"Z-fighting: safe gap {_fmt(rule[0])} (more for wide layers, up to {_fmt(rule[2])})."
    if not found:
        return "\n".join([head] + lines + ["No surfaces that will flicker." + (" (Checked only part: the scene is very large.)" if detail.get("truncated") else "")])
    lines += [describe(f) for f in found[:30]]
    if len(found) > 30:
        lines.append(f"… and {len(found) - 30} more pairs")
    lines.append("Fix each: merge the parts, inset or extrude the detail into the surface, or move the layers at least the gap apart (kiln.zfight(objs, fix=True) does the last).")
    return "\n".join([head] + lines)


def describe(f):
    where = "inside " + f["a"] if f["inside"] else f"{f['a']} / {f['b']}"
    how = "flush (coplanar)" if f["kind"] == "flush" else f"{_fmt(f['sep'])} apart"
    return f"{where}: {f['faces']} overlapping face pair(s) {how}, needs {_fmt(f['gap'])}, at {f['where']}"


# --- the whole-scene check ----------------------------------------------------------------------------

def check_scene(tol=None, fix=False, nudge=None, max_tris=800000):
    """Z-fighting, floating parts and parts below the ground. fix: moves z-fighting layers apart (and the
    reply lists what is left). tol / nudge are from older callers: tol overrides the flush threshold, nudge
    the base gap."""
    if bpy.context.mode != "OBJECT":
        try:
            bpy.ops.object.mode_set(mode="OBJECT")
        except Exception:  # noqa: BLE001
            pass
    rule = zfight_rule()
    if tol is not None or nudge is not None:
        rule = (float(nudge) if nudge else rule[0], rule[1], max(rule[2], float(nudge or 0)), float(tol) if tol else rule[3])
    dg = bpy.context.evaluated_depsgraph_get()
    boxes, geo, items = {}, {}, []
    for ob in _visible_meshes():
        r = _evaluated(ob, dg)
        if r is None:
            continue
        w, tri, poly = r
        boxes[ob.name] = (w.min(0), w.max(0))
        if len(tri) <= 250000:
            geo[ob.name] = (w, tri)
        items.append((ob.name, w, tri, poly))

    t0 = time.time()
    found, detail = find_zfight(rule=rule, max_tris=max_tris, _items=items)
    moved = []
    if fix and found:
        moved = fix_zfight(found, detail)
        dg = bpy.context.evaluated_depsgraph_get()
        items, boxes, geo = [], {}, {}
        for ob in _visible_meshes():
            r = _evaluated(ob, dg)
            if r is None:
                continue
            boxes[ob.name] = (r[0].min(0), r[0].max(0))
            if len(r[1]) <= 250000:
                geo[ob.name] = (r[0], r[1])
            items.append((ob.name, r[0], r[1], r[2]))
        found, detail = find_zfight(rule=rule, max_tris=max_tris, _items=items)
    zms = int((time.time() - t0) * 1000)

    floating, below = [], []
    trees, deadline = {}, time.time() + 3.0
    box_items = list(boxes.items())
    if box_items:
        lo_all = np.array([b[0] for _, b in box_items])
        hi_all = np.array([b[1] for _, b in box_items])
        for i, (name, (lo, hi)) in enumerate(box_items):
            if hi[2] < -0.001:
                below.append({"object": name, "top_z": round(float(hi[2]), 3)})
            if lo[2] <= 0.02:
                continue
            touch = np.all(np.minimum(hi, hi_all) - np.maximum(lo, lo_all) >= -0.002, axis=1)
            touch[i] = False
            if not touch.any():
                floating.append({"object": name, "gap_below_m": round(float(lo[2]), 3)})
                continue
            # Boxes that overlap prove nothing: a lamp can hang in the air inside a room's box, a sign beside
            # an L-shaped wall. Measure the real gap to the neighbours (for a while: big scenes get the box test).
            if name in geo and len(box_items) <= 600:
                gap = _gap(name, [box_items[j][0] for j in np.nonzero(touch)[0]], geo, trees, deadline)
                size = float(np.linalg.norm(hi - lo))
                if gap is not None and gap > max(0.02, 0.05 * size):
                    floating.append({"object": name, "gap_below_m": round(float(lo[2]), 3), "nearest_m": round(float(gap), 3)})
    base, per_width, cap, flush = rule
    return {
        "zfight": found[:40], "zfight_pairs": len(found), "zfight_rule": {"gap": base, "per_width": per_width, "cap": cap, "flush": flush, "units": CONTEXT.get("units") or "m", "roblox": bool(CONTEXT.get("roblox"))},
        "zfight_truncated": bool(detail.get("truncated")), "zfight_ms": zms,
        "floating": floating[:30], "below_ground": below[:30], "moved": moved, "faces_checked": int(detail.get("checked", 0)),
    }
