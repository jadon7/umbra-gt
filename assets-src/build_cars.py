"""
在 Blender 里生成游戏用的几台新车（车身是代码放样出来的，车轮、方向盘、座椅、车牌从原型车上复制）。

用法：在打开了 car.blend 的 Blender 里执行
    exec(open('/…/assets-src/build_cars.py').read()); build('brute')
每台车放在自己的集合里（Car_<id>），导出时对象名换成游戏约定的名字（Car、Body、Wheel_FL …）。

坐标：Blender 里车头朝 -Y，左侧 +X，上 +Z（和原型车一致），导出时转成游戏里的车头 +Z。
"""
import math

import bmesh
import bpy
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

K = 11  # 半个横截面上的点数：0 底部中线 … 5 肩线 … 10 顶部中线
import os
# 导出到项目的 public/models/（本文件在 assets-src/ 下；在 Blender 里运行时 __file__ 可能不可用，就退回当前目录）
_HERE = os.path.dirname(os.path.abspath(__file__)) if '__file__' in globals() else os.getcwd()
EXPORT_DIR = os.path.join(os.path.dirname(_HERE), 'public', 'models') + os.sep
GT_EYE = Vector((0.0, -0.5, 1.0))  # 原型车驾驶员眼睛的位置（Blender 坐标）


def lerp(a, b, t):
    return a + (b - a) * t


def get_mat(name):
    m = bpy.data.materials.get(name)
    if m is None:
        m = bpy.data.materials.new(name)
        m.use_nodes = True
    return m


def collection_for(car_id):
    name = 'Car_' + car_id
    old = bpy.data.collections.get(name)
    if old:
        for o in list(old.objects):
            bpy.data.objects.remove(o, do_unlink=True)
        bpy.data.collections.remove(old)
    c = bpy.data.collections.new(name)
    bpy.context.scene.collection.children.link(c)
    return c


def new_empty(coll, name, export, parent=None, loc=(0, 0, 0)):
    o = bpy.data.objects.new(name, None)
    o.empty_display_size = 0.1
    o.location = loc
    coll.objects.link(o)
    o['export_name'] = export
    if parent:
        o.parent = parent
    return o


def link_mesh(coll, name, mesh, export, parent):
    o = bpy.data.objects.new(name, mesh)
    coll.objects.link(o)
    o['export_name'] = export
    o.parent = parent
    return o


# ---------------------------------------------------------------- 横截面


def ring_points(st):
    """一个横截面的左半边（x >= 0）的 K 个点，从底部中线绕到顶部中线。"""
    y, zb, zs, zt, w = st['y'], st['zb'], st['zs'], st['zt'], st['w']
    wb = st.get('wb', w - 0.07)
    g = st.get('g', 0.0)
    wr = st.get('wr', w * 0.74)
    ledge = st.get('ledge', 0.055)
    flare = st.get('flare', 0.0)
    h = zs - zb
    c = zt - zs
    pts = [
        (0.0, zb),
        (wb * 0.55, zb),
        (wb, zb + 0.035),
        (w - 0.014 + flare, zb + h * 0.36),
        (w + flare * 0.6, zb + h * 0.74),
        (w - 0.024, zs),
    ]
    # 没有车窗的地方（发动机盖、后备箱）：从肩线往中间拱上去
    hood = [(w - 0.11, zs + c * 0.42), (w * 0.7, zs + c * 0.78), (w * 0.44, zs + c * 0.95), (w * 0.2, zt), (0.0, zt)]
    # 有车窗的地方：肩线往里收一个台阶，侧窗往里倾，到车顶
    wg = w - ledge
    green = [(wg, zs + 0.014), (wg + (wr - wg) * 0.5 + 0.016, zs + c * 0.56), (wr, zt - 0.05), (wr * 0.55, zt - 0.013), (0.0, zt)]
    for a, b in zip(hood, green):
        pts.append((lerp(a[0], b[0], g), lerp(a[1], b[1], g)))
    return [Vector((x, y, z)) for (x, z) in pts]


def pick_material(rules, kind, s, j, col, default):
    name = default
    for r in rules:
        if r[0] != kind:
            continue
        if not (r[1] <= s <= r[2] and r[3] <= j <= r[4]):
            continue
        if len(r) > 6 and r[6] is not None and r[6] != col:
            continue
        name = r[5]
    return name


def build_shell(name, stations, rules, crease_rows=((5, 0.55),), ring_creases=(), cap_bulge=(0.05, 0.04), cap_c=0.5, end_crease=0.35, inner=False, s_range=None, skip=()):
    """
    把一排横截面放样成一个封闭的壳。
    rules：给面指定材质，(kind, s0, s1, j0, j1, 材质名[, 列])，后面的规则盖掉前面的。
      kind='band'：第 s 个和第 s+1 个横截面之间的那一圈，j 是横截面上第 j 和 j+1 个点之间的那一条
      kind='front' / 'rear'：车头、车尾的封口，j 是从下往上第几条，列 0 = 两边，1 = 中间
    inner=True 时做的是内衬：只取 s_range 这一段、不要 skip 里的材质（玻璃），面朝里。
    """
    bm = bmesh.new()
    crease = bm.edges.layers.float.new('crease_edge')
    rings = []
    for st in stations:
        P = ring_points(st)
        L = [bm.verts.new(p) for p in P]
        R = [None] * K
        R[0], R[K - 1] = L[0], L[K - 1]
        for i in range(1, K - 1):
            R[i] = bm.verts.new(Vector((-P[i].x, P[i].y, P[i].z)))
        rings.append((L, R))
    names = []

    def mi(n):
        if n not in names:
            names.append(n)
        return names.index(n)

    def face(verts, kind, s, j, col=0):
        default = 'Trim_Black' if j <= 1 else 'Paint_Primary'
        m = pick_material(rules, kind, s, j, col, default)
        if inner and m in skip:
            return
        vs = []
        for v in verts:
            if v not in vs:
                vs.append(v)
        if len(vs) < 3:
            return
        try:
            f = bm.faces.new(vs)
        except ValueError:
            return
        f.material_index = mi(m)

    n = len(stations)
    s0, s1 = (0, n - 1) if s_range is None else s_range
    for s in range(s0, s1):
        (L0, R0), (L1, R1) = rings[s], rings[s + 1]
        for j in range(K - 1):
            face([L0[j], L0[j + 1], L1[j + 1], L1[j]], 'band', s, j)
            face([R0[j + 1], R0[j], R1[j], R1[j + 1]], 'band', s, j)

    def cap(L, R, kind, bulge, sign):
        Lc, Rc = [None] * K, [None] * K
        for i in range(1, K - 1):
            b = bulge * math.sin(math.pi * i / (K - 1)) ** 0.7
            Lc[i] = bm.verts.new((L[i].co.x * cap_c, L[i].co.y + sign * b, L[i].co.z))
            Rc[i] = bm.verts.new((-L[i].co.x * cap_c, L[i].co.y + sign * b, L[i].co.z))
        for i in range(K - 1):
            if i == 0:
                face([L[0], L[1], Lc[1]], kind, 0, i, 0)
                face([L[0], Lc[1], Rc[1]], kind, 0, i, 1)
                face([L[0], Rc[1], R[1]], kind, 0, i, 0)
            elif i == K - 2:
                face([L[i], L[K - 1], Lc[i]], kind, 0, i, 0)
                face([Lc[i], L[K - 1], Rc[i]], kind, 0, i, 1)
                face([Rc[i], L[K - 1], R[i]], kind, 0, i, 0)
            else:
                face([L[i], L[i + 1], Lc[i + 1], Lc[i]], kind, 0, i, 0)
                face([Lc[i], Lc[i + 1], Rc[i + 1], Rc[i]], kind, 0, i, 1)
                face([Rc[i], Rc[i + 1], R[i + 1], R[i]], kind, 0, i, 0)

    if not inner:
        cap(rings[0][0], rings[0][1], 'front', cap_bulge[0], -1)
        cap(rings[-1][0], rings[-1][1], 'rear', cap_bulge[1], 1)
    else:
        # 内衬两头各封一块板（前面是防火墙，后面是后舱隔板）
        for s in (s0, s1):
            L, R = rings[s]
            for i in range(2, K - 1):
                face([L[i], L[i + 1], R[i + 1], R[i]], 'bulk', s, i)

    bm.verts.ensure_lookup_table()
    bm.edges.ensure_lookup_table()

    def set_crease(a, b, v):
        e = bm.edges.get((a, b))
        if e:
            e[crease] = max(e[crease], v)

    for s in range(s0, s1):
        for row, v in crease_rows:
            for side in (0, 1):
                set_crease(rings[s][side][row], rings[s + 1][side][row], v)
    for s, j0, j1, v in ring_creases:
        if s < s0 or s > s1:
            continue
        for j in range(j0, j1 + 1):
            for side in (0, 1):
                set_crease(rings[s][side][j], rings[s][side][j + 1], v)
    if not inner and end_crease > 0:
        for s in (0, n - 1):
            for j in range(K - 1):
                for side in (0, 1):
                    set_crease(rings[s][side][j], rings[s][side][j + 1], end_crease)

    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    if inner:
        for f in bm.faces:
            f.normal_flip()
        bm.normal_update()
        for v in bm.verts:
            v.co += v.normal * 0.03  # 面已经朝里，沿法线走就是往里缩
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    for nme in names:
        mesh.materials.append(get_mat(nme))
    return mesh


def finish_mesh(obj, subsurf=2, cutters=(), sharp_deg=38):
    """细分、挖洞，再按夹角标出硬边。"""
    bpy.context.view_layer.objects.active = obj
    for o in bpy.context.selected_objects:
        o.select_set(False)
    obj.select_set(True)
    if subsurf:
        m = obj.modifiers.new('Subsurf', 'SUBSURF')
        m.levels = subsurf
        m.render_levels = subsurf
        bpy.ops.object.modifier_apply(modifier=m.name)
    for c in cutters:
        m = obj.modifiers.new('Cut', 'BOOLEAN')
        m.operation = 'DIFFERENCE'
        m.object = c
        m.solver = 'EXACT'
        bpy.ops.object.modifier_apply(modifier=m.name)
    mesh = obj.data
    bm = bmesh.new()
    bm.from_mesh(mesh)
    limit = math.radians(sharp_deg)
    for f in bm.faces:
        f.smooth = True
    for e in bm.edges:
        if len(e.link_faces) == 2:
            e.smooth = e.calc_face_angle(0.0) < limit
            # 材质交界（玻璃和车漆之间）不强制硬边：靠折痕保持形状
    bm.to_mesh(mesh)
    bm.free()
    mesh.update()


def make_lining(shell_mesh, name, y0, y1, belt):
    """
    车壳的内衬：复制车壳，只留座舱那一段（y0–y1），去掉玻璃和车灯，面朝里，往里缩 1.2 厘米。
    肩线以下用门板的材质，以上（立柱、顶棚）用黑色。
    """
    bm = bmesh.new()
    bm.from_mesh(shell_mesh)
    kill_names = ('Glass', 'Light_Head', 'Light_Tail', 'Light_Signal')
    kill_idx = {i for i, m in enumerate(shell_mesh.materials) if m.name in kill_names}
    kill = [f for f in bm.faces if f.material_index in kill_idx or f.calc_center_median().y < y0 or f.calc_center_median().y > y1]
    bmesh.ops.delete(bm, geom=kill, context='FACES')
    for f in bm.faces:
        f.normal_flip()
    bm.normal_update()
    # 窗洞边上的那一圈顶点留在原地（和车壳贴在一起），其余的往里缩：
    # 不然内衬和车壳之间有一道缝，从车里看窗框边上会露出一条车漆的颜色
    rim = {v for e in bm.edges if len(e.link_faces) == 1 for v in e.verts}
    for v in bm.verts:
        if v in rim and y0 + 0.02 < v.co.y < y1 - 0.02:
            v.co += v.normal * 0.0015
        else:
            v.co += v.normal * 0.012
    for f in bm.faces:
        f.material_index = 0 if f.calc_center_median().z > belt + 0.02 else 1
        f.smooth = True
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    mesh.materials.append(get_mat('Trim_Black'))
    mesh.materials.append(get_mat('Interior_Panel'))
    return mesh


def section_cap(name, st, y, inset=0.035, mat='Trim_Black'):
    """
    一块和车身横截面一样形状的隔板（防火墙、后舱隔板）：按这个截面的轮廓往里缩一点。
    用方块的话顶上会从发动机盖、后窗下面戳出来。两面都要看得见，所以正反各做一个面。
    """
    P = ring_points(st)
    loop = [(p.x, p.z) for p in P] + [(-p.x, p.z) for p in reversed(P[1:-1])]
    cx = 0.0
    cz = sum(z for _x, z in loop) / len(loop)
    pts = []
    for x, z in loop:
        d = Vector((x - cx, z - cz))
        if d.length > 1e-6:
            d = d.normalized() * max(0.0, d.length - inset)
        pts.append(Vector((cx + d.x, y, cz + d.y)))
    mesh = bpy.data.meshes.new(name)
    bm = bmesh.new()
    a = [bm.verts.new(p) for p in pts]
    bm.faces.new(a)
    b = [bm.verts.new(p) for p in reversed(pts)]
    bm.faces.new(b)
    bm.to_mesh(mesh)
    bm.free()
    mesh.materials.append(get_mat(mat))
    return mesh


def temp_cylinder(radius, depth, loc, mat_name, segments=40):
    """挖轮拱用的圆柱，轴沿 X。挖出来的面用 mat_name 这种材质。"""
    mesh = bpy.data.meshes.new('cutter')
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=segments, radius1=radius, radius2=radius, depth=depth, matrix=Matrix.Rotation(math.pi / 2, 4, 'Y'))
    bm.to_mesh(mesh)
    bm.free()
    mesh.materials.append(get_mat(mat_name))
    o = bpy.data.objects.new('cutter', mesh)
    o.location = loc
    bpy.context.scene.collection.objects.link(o)
    return o


def temp_box(size, loc, mat_name):
    mesh = bpy.data.meshes.new('cutter')
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co = Vector((v.co.x * size[0], v.co.y * size[1], v.co.z * size[2]))
    bm.to_mesh(mesh)
    bm.free()
    mesh.materials.append(get_mat(mat_name))
    o = bpy.data.objects.new('cutter', mesh)
    o.location = loc
    bpy.context.scene.collection.objects.link(o)
    return o


# ---------------------------------------------------------------- 小部件


def box_mesh(name, size, bevel=0.0, segments=2, mat='Trim_Black', taper=None):
    """一块倒了角的方块。taper=(sx, sy)：顶面相对底面缩小的比例。"""
    mesh = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        k = (1.0, 1.0)
        if taper and v.co.z > 0:
            k = taper
        v.co = Vector((v.co.x * size[0] * k[0], v.co.y * size[1] * k[1], v.co.z * size[2]))
    if bevel > 0:
        bmesh.ops.bevel(bm, geom=list(bm.edges), offset=bevel, segments=segments, profile=0.5, affect='EDGES')
    for f in bm.faces:
        f.smooth = True
    bm.to_mesh(mesh)
    bm.free()
    mesh.materials.append(get_mat(mat))
    return mesh


def add_box(coll, parent, name, size, loc, rot=(0, 0, 0), bevel=0.01, mat='Trim_Black', taper=None, export=None):
    o = link_mesh(coll, name, box_mesh(name, size, bevel, 2, mat, taper), export or name, parent)
    o.location = loc
    o.rotation_euler = rot
    mark_sharp(o, 50)
    return o


def mark_sharp(obj, deg=40):
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    limit = math.radians(deg)
    for f in bm.faces:
        f.smooth = True
    for e in bm.edges:
        if len(e.link_faces) == 2:
            e.smooth = e.calc_face_angle(0.0) < limit
    bm.to_mesh(obj.data)
    bm.free()


def tube_mesh(name, points, radius, mat='Trim_Black', segments=10, closed=False):
    """沿一串点扫出来的圆管（防滚架、保险杠管）。"""
    mesh = bpy.data.meshes.new(name)
    bm = bmesh.new()
    pts = [Vector(p) for p in points]
    rings = []
    n = len(pts)
    for i, p in enumerate(pts):
        a = pts[i - 1] if i > 0 else (pts[-1] if closed else p)
        b = pts[i + 1] if i < n - 1 else (pts[0] if closed else p)
        t = (b - a).normalized() if (b - a).length > 1e-6 else Vector((0, 0, 1))
        ref = Vector((0, 0, 1)) if abs(t.z) < 0.9 else Vector((1, 0, 0))
        u = t.cross(ref).normalized()
        v = t.cross(u).normalized()
        rings.append([bm.verts.new(p + (u * math.cos(k / segments * 2 * math.pi) + v * math.sin(k / segments * 2 * math.pi)) * radius) for k in range(segments)])
    last = n if closed else n - 1
    for i in range(last):
        r0, r1 = rings[i], rings[(i + 1) % n]
        for k in range(segments):
            bm.faces.new([r0[k], r0[(k + 1) % segments], r1[(k + 1) % segments], r1[k]])
    if not closed:
        bm.faces.new(list(reversed(rings[0])))
        bm.faces.new(rings[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    for f in bm.faces:
        f.smooth = True
    bm.to_mesh(mesh)
    bm.free()
    mesh.materials.append(get_mat(mat))
    return mesh


def add_tube(coll, parent, name, points, radius, mat='Trim_Black', closed=False):
    o = link_mesh(coll, name, tube_mesh(name, points, radius, mat, 10, closed), name, parent)
    mark_sharp(o, 60)
    return o


def cylinder_mesh(name, radius, depth, mat, axis='Y', segments=24, inner=None, inner_mat=None):
    """圆柱；inner 给了就是一截有壁厚的管（排气尾喉）。"""
    mesh = bpy.data.meshes.new(name)
    bm = bmesh.new()
    rot = {'X': Matrix.Rotation(math.pi / 2, 4, 'Y'), 'Y': Matrix.Rotation(math.pi / 2, 4, 'X'), 'Z': Matrix.Identity(4)}[axis]
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=segments, radius1=radius, radius2=radius, depth=depth, matrix=rot)
    names = [mat]
    if inner:
        # 朝外的那个端面往里挖一个坑
        for f in list(bm.faces):
            if len(f.verts) > 4:
                ax = {'X': 0, 'Y': 1, 'Z': 2}[axis]
                if f.calc_center_median()[ax] > 0:
                    r = bmesh.ops.inset_region(bm, faces=[f], thickness=radius - inner)
                    moved = bmesh.ops.extrude_discrete_faces(bm, faces=[f])['faces']
                    for nf in moved:
                        for v in nf.verts:
                            v.co[ax] -= depth * 0.8
                        nf.material_index = 1
                    names.append(inner_mat or 'Exhaust_Inner')
    for f in bm.faces:
        f.smooth = True
    bm.to_mesh(mesh)
    bm.free()
    for nme in names:
        mesh.materials.append(get_mat(nme))
    return mesh


# ---------------------------------------------------------------- 从原型车上复制


def copy_tree(src, coll, parent, rename=None):
    """连同子节点一起复制一个对象（网格数据共用）。返回新对象。"""
    o = src.copy()
    coll.objects.link(o)
    o.parent = parent
    o.matrix_parent_inverse = src.matrix_parent_inverse.copy()
    base = src.name.split('.')[0]
    o['export_name'] = rename(base) if rename else base
    for c in src.children:
        copy_tree(c, coll, o, rename)
    return o


def copy_wheels(coll, root, wheels, wide=None):
    """
    wheels: {'FL': (x, y, 半径)…}。从原型车复制整个车轮，挪到新位置，按半径缩放。
    右侧的车轮用原型车右侧的（轮辋花纹是镜像的）。
    wide: {'RL': 1.15…} 轮胎和轮辋加宽的倍数（沿车轴方向）。
    """
    out = {}
    wide = wide or {}
    for tag, (x, y, r) in wheels.items():
        src = bpy.data.objects['Wheel_' + tag]
        o = copy_tree(src, coll, root)
        o.matrix_parent_inverse = Matrix.Identity(4)
        o.location = (x, y, r)
        k = r / 0.384
        for c in o.children:
            # 滚动轴心下面挂着轮胎和轮辋：加宽只加在它上面，卡钳不动
            wx = wide.get(tag, 1.0) if c.type == 'EMPTY' else 1.0
            c.scale = (c.scale[0] * k * wx, c.scale[1] * k, c.scale[2] * k)
            # 子节点相对车轮中心的偏移也要跟着放大（卡钳）
            c.location = c.location * k
        out[tag] = o
    return out


def offroad_tire_mesh(name, radius, bead, width, lugs=30):
    """
    越野胎：胎壁高、胎肩方，胎面和胎肩上有一圈凸起的花纹块。绕 X 轴（车轴）旋转成形。
    radius 外半径，bead 胎圈（套在轮辋上的那一圈）的半径，width 胎宽。
    """
    mesh = bpy.data.meshes.new(name)
    bm = bmesh.new()
    w = width / 2
    # 半个截面：从胎圈到胎面中线（x 是沿车轴方向，r 是半径）
    half = [(w - 0.03, bead), (w, bead + 0.035), (w + 0.012, (bead + radius) / 2), (w, radius - 0.075), (w - 0.03, radius - 0.02), (w - 0.075, radius - 0.004), (0.0, radius)]
    profile = half + [(-x, r) for x, r in reversed(half[:-1])]
    seg = 64
    rings = []
    for i in range(seg):
        a = i / seg * 2 * math.pi
        rings.append([bm.verts.new((x, math.cos(a) * r, math.sin(a) * r)) for x, r in profile])
    n = len(profile)
    for i in range(seg):
        r0, r1 = rings[i], rings[(i + 1) % seg]
        for j in range(n - 1):
            f = bm.faces.new([r0[j], r0[j + 1], r1[j + 1], r1[j]])
            # 胎肩以内算胎面，其余是胎壁
            f.material_index = 1 if 3 <= j <= n - 5 else 0
            f.smooth = True
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    # 花纹块：胎肩两排、胎面中间两排，错开排
    def lug(x, a, sx, sa, h, r):
        geom = bmesh.ops.create_cube(bm, size=1.0)['verts']
        for v in geom:
            lx = v.co.x * sx + x
            la = v.co.y * sa
            lr = r + (v.co.z + 0.5) * h
            ang = a + la / r
            v.co = Vector((lx, math.cos(ang) * lr, math.sin(ang) * lr))
        for f in {f for v in geom for f in v.link_faces}:
            f.material_index = 1
    for i in range(lugs):
        a = i / lugs * 2 * math.pi
        b = a + math.pi / lugs
        for s in (1, -1):
            lug(s * (w - 0.035), a if s > 0 else b, 0.075, 0.062, 0.02, radius - 0.03)
            lug(s * 0.055, b if s > 0 else a, 0.085, 0.058, 0.016, radius - 0.006)
    bm.to_mesh(mesh)
    bm.free()
    mesh.materials.append(get_mat('Tire_Side'))
    mesh.materials.append(get_mat('Tire_Tread'))
    return mesh


def fit_offroad_tires(coll, wheels_out, radius, width, rim_scale=0.8):
    """把复制过来的薄胎换成越野胎，轮辋相应缩小一圈（胎壁才显得高）。"""
    mesh = offroad_tire_mesh('OffroadTire', radius, radius * 0.64, width)
    for tag, wheel in wheels_out.items():
        spin = next(c for c in wheel.children if c.type == 'EMPTY')
        for c in list(spin.children):
            if 'Tire' in c.name:
                name = c.get('export_name', 'Wheel_%s_Tire' % tag)
                bpy.data.objects.remove(c, do_unlink=True)
                o = bpy.data.objects.new('Tire_' + tag, mesh)
                coll.objects.link(o)
                o.parent = spin
                o.matrix_parent_inverse = Matrix.Identity(4)
                # 滚动轴心自己带着缩放（车轮放大、加宽），新轮胎是按真实尺寸做的，要抵消掉
                o.scale = (1 / spin.scale[0], 1 / spin.scale[1], 1 / spin.scale[2])
                o['export_name'] = name
            elif 'Rim' in c.name:
                c.matrix_local = Matrix.Diagonal((1.0, rim_scale, rim_scale, 1.0)) @ c.matrix_local


def copy_part(coll, parent, src_name, delta, export=None, scale=None):
    """复制原型车上的一个部件（连同子节点），整体平移 delta。"""
    src = bpy.data.objects[src_name]
    o = copy_tree(src, coll, parent)
    world = src.matrix_world.copy()
    o.matrix_parent_inverse = Matrix.Identity(4)
    o.matrix_world = Matrix.Translation(Vector(delta)) @ world
    if export:
        o['export_name'] = export
    if scale:
        o.scale = (o.scale[0] * scale, o.scale[1] * scale, o.scale[2] * scale)
    return o


_seat_cache = {}


def front_seat_meshes():
    """把原型车中间那个前排座椅从整块座椅网格里切出来（原型车是 1+2 的三座布局）。"""
    if _seat_cache:
        return _seat_cache
    for n in ['InteriorSeatsColor1', 'InteriorSeatsColor2', 'InteriorSeatsFrame1', 'InteriorSeatsFrame2']:
        src = bpy.data.objects[n]
        bm = bmesh.new()
        bm.from_mesh(src.data)
        bm.transform(src.matrix_world)
        # 前排座椅在 y < 0.05、|x| < 0.34 的范围里
        kill = [f for f in bm.faces if f.calc_center_median().y > 0.05 or abs(f.calc_center_median().x) > 0.36]
        bmesh.ops.delete(bm, geom=kill, context='FACES')
        mesh = bpy.data.meshes.new('Seat_' + n)
        bm.to_mesh(mesh)
        bm.free()
        for s in src.material_slots:
            mesh.materials.append(s.material)
        _seat_cache[n] = mesh
    return _seat_cache


def add_seat(coll, parent, tag, delta):
    for n, mesh in front_seat_meshes().items():
        o = link_mesh(coll, 'Interior' + tag + n[8:], mesh, 'Interior' + tag + n[8:], parent)
        o.location = delta


STEERING = ['InteriorSteeringCylinder', 'InteriorSteeringBase', 'InteriorSteeringDash', 'InteriorSteeringDashColumn', 'InteriorSteeringHandleL', 'InteriorSteeringHandleR']


def add_cockpit(coll, body, eye, dash, passenger=True):
    """
    方向盘、仪表屏、座椅、仪表台。eye 是驾驶员眼睛的位置；
    dash = (前沿 y, 半宽)。仪表台的高度和后沿按眼睛的位置定：比仪表屏矮一截，屏幕从台面上立起来。
    """
    delta = Vector(eye) - GT_EYE
    for n in STEERING:
        copy_part(coll, body, n, delta)
    # 座椅比原型车再靠后一点：原型车的头枕两翼紧贴着眼睛，换了座舱以后会挡到视野边上
    seat = delta + Vector((0, 0.09, -0.02))
    add_seat(coll, body, 'SeatL', seat)
    if passenger:
        add_seat(coll, body, 'SeatR', Vector((-2 * eye[0], 0, 0)) + seat)
    y0, hw = dash
    y1 = eye[1] - 0.66
    top = eye[2] - 0.3
    add_box(coll, body, 'InteriorDashTop', (hw * 2, y1 - y0, 0.34), (0, (y0 + y1) / 2, top - 0.17), bevel=0.04, mat='Interior_Dark', taper=(1.0, 0.8))
    # 仪表屏上面的遮光檐
    add_box(coll, body, 'InteriorBinnacle', (0.46, 0.3, 0.035), (eye[0], eye[1] - 0.9, eye[2] - 0.175), rot=(-0.12, 0, 0), bevel=0.012, mat='Interior_Dark')
    # 中控台、地板
    add_box(coll, body, 'InteriorConsole', (0.24, 1.2, 0.16), (0, eye[1] - 0.2, eye[2] - 0.7), bevel=0.03, mat='Interior_Panel')
    add_box(coll, body, 'InteriorFloorPan', (hw * 2 - 0.1, 2.0, 0.03), (0, eye[1] + 0.1, eye[2] - 0.88), bevel=0.0, mat='Trim_Black')


def arc_points(x, y, z, radius, a0, a1, n=14):
    """轮拱上方的一段圆弧（在 YZ 平面里），给轮眉用。角度从车头方向的水平线算起。"""
    return [(x, y - math.cos(math.radians(a0 + (a1 - a0) * i / n)) * radius, z + math.sin(math.radians(a0 + (a1 - a0) * i / n)) * radius) for i in range(n + 1)]


def add_anchor(coll, body, name, loc):
    return new_empty(coll, name, name, body, loc)


def add_plate(coll, body, y, z, front=False):
    src = bpy.data.objects['LicensePlate']
    o = copy_tree(src, coll, body)
    o.matrix_parent_inverse = Matrix.Identity(4)
    c = Vector((0, 1.90, 0.315))
    m = Matrix.Translation(Vector((0, y, z)) - c) @ src.matrix_world
    o.matrix_world = m
    return o


def add_mirrors(coll, body, x, y, z, mat='Paint_Primary'):
    for s, tag in ((1, 'L'), (-1, 'R')):
        add_box(coll, body, 'BodyMirror' + tag, (0.2, 0.09, 0.115), (s * (x + 0.1), y, z), rot=(0, 0, s * 0.12), bevel=0.03, mat=mat)
        add_box(coll, body, 'BodyMirrorArm' + tag, (0.14, 0.05, 0.035), (s * (x + 0.02), y + 0.01, z - 0.05), rot=(0, s * 0.35, 0), bevel=0.012, mat='Trim_Black')
        add_box(coll, body, 'BodyMirrorGlass' + tag, (0.16, 0.008, 0.085), (s * (x + 0.1), y + 0.047, z), rot=(0, 0, s * 0.12), bevel=0.0, mat='Mirror')


def add_exhaust(coll, body, xs, y, z, radius=0.05):
    for i, x in enumerate(xs):
        mesh = cylinder_mesh('BodyExhaustTip%d' % i, radius, 0.22, 'Exhaust_Tip', 'Y', 20, inner=radius * 0.78)
        o = link_mesh(coll, 'BodyExhaustTip%d' % i, mesh, 'BodyExhaustTip%d' % i, body)
        o.location = (x, y - 0.09, z)
        mark_sharp(o, 40)


# ---------------------------------------------------------------- 贴在车身表面上的细节


def surface_tree(obj):
    """车壳的碰撞查询结构：往车身上打射线，找表面上的点和法线。"""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    tree = BVHTree.FromBMesh(bm)
    bm.free()
    return tree


def resample(points, step=0.025):
    """把折线加密：每隔 step 米一个点。"""
    out = []
    for a, b in zip(points, points[1:]):
        a, b = Vector(a), Vector(b)
        n = max(1, int(round((b - a).length / step)))
        for i in range(n):
            out.append(a.lerp(b, i / n))
    out.append(Vector(points[-1]))
    return out


def fillet(points, r, seg=5):
    """把折线的拐角削圆（二维）。"""
    pts = [Vector(p) for p in points]
    out = [pts[0]]
    for i in range(1, len(pts) - 1):
        p, a, b = pts[i], pts[i - 1], pts[i + 1]
        da = (a - p)
        db = (b - p)
        ra = min(r, da.length * 0.45)
        rb = min(r, db.length * 0.45)
        s = p + da.normalized() * ra
        e = p + db.normalized() * rb
        for k in range(seg + 1):
            t = k / seg
            out.append((1 - t) * (1 - t) * s + 2 * t * (1 - t) * p + t * t * e)
    out.append(pts[-1])
    return out


def circle(cx, cy, r, n=28):
    return [(cx + math.cos(i / n * 2 * math.pi) * r, cy + math.sin(i / n * 2 * math.pi) * r) for i in range(n + 1)]


def project(tree, pts, axis, sign=1):
    """
    把一串二维的点投到车身表面上，返回 [(位置, 法线)…]。
    axis='x'：从侧面投，点是 (y, z)；sign=+1 是左侧（+X），-1 是右侧
    axis='z'：从上往下投，点是 (x, y)
    axis='y'：从前后投，点是 (x, z)；sign=-1 是车头（-Y），+1 是车尾
    """
    res = []
    for p in pts:
        if axis == 'x':
            o, d = Vector((sign * 4, p[0], p[1])), Vector((-sign, 0, 0))
        elif axis == 'z':
            o, d = Vector((p[0], p[1], 5)), Vector((0, 0, -1))
        else:
            o, d = Vector((p[0], sign * 6, p[1])), Vector((0, -sign, 0))
        loc, nor, _idx, _dist = tree.ray_cast(o, d)
        if loc is not None:
            res.append((loc, nor))
    return res


def ribbon_mesh(name, hits, width, lift, mat):
    """沿着表面上的一串点铺一条细带子（贴着表面、略微浮起）。"""
    mesh = bpy.data.meshes.new(name)
    bm = bmesh.new()
    rows = []
    n = len(hits)
    for i, (p, nor) in enumerate(hits):
        a = hits[max(0, i - 1)][0]
        b = hits[min(n - 1, i + 1)][0]
        t = b - a
        if t.length < 1e-6:
            continue
        side = t.normalized().cross(nor)
        if side.length < 1e-6:
            continue
        side.normalize()
        base = p + nor * lift
        rows.append((bm.verts.new(base + side * width / 2), bm.verts.new(base - side * width / 2), nor))
    for (a0, b0, n0), (a1, b1, _n1) in zip(rows, rows[1:]):
        f = bm.faces.new([a0, a1, b1, b0])
        f.normal_update()
        if f.normal.dot(n0) < 0:
            f.normal_flip()
        f.smooth = True
    bm.to_mesh(mesh)
    bm.free()
    mesh.materials.append(get_mat(mat))
    return mesh


def add_seam(coll, body, tree, name, path, axis, sign=1, width=0.008, lift=0.0015, mat='Trim_Black', step=0.025):
    """在车身表面画一条缝（车门缝、发动机盖的缝）或者一块细长的黑条（散热口）。"""
    hits = project(tree, resample(path, step), axis, sign)
    if len(hits) < 2:
        return None
    return link_mesh(coll, name, ribbon_mesh(name, hits, width, lift, mat), name, body)


def add_seam_both(coll, body, tree, name, path, width=0.008, mat='Trim_Black'):
    """车身两侧各画一条一样的缝（路径是侧视图里的 (y, z)）。"""
    add_seam(coll, body, tree, name + 'L', path, 'x', 1, width, mat=mat)
    add_seam(coll, body, tree, name + 'R', path, 'x', -1, width, mat=mat)


def add_on_surface(coll, body, tree, name, mesh, point, axis, sign=1, lift=0.0, spin=0.0):
    """把一个小部件（门把手、雾灯）贴到车身表面上：本地 +Z 朝外。"""
    hits = project(tree, [point], axis, sign)
    if not hits:
        return None
    loc, nor = hits[0]
    o = link_mesh(coll, name, mesh, name, body)
    q = Vector((0, 0, 1)).rotation_difference(nor)
    o.rotation_mode = 'QUATERNION'
    o.rotation_quaternion = q @ Matrix.Rotation(spin, 4, 'Z').to_quaternion()
    o.location = loc + nor * lift
    return o


def boundary_trim(coll, body, shell, name, inside, width=0.014, lift=0.0016, mat='Trim_Black'):
    """
    沿着两种材质的交界画一圈边：车窗玻璃四周的黑色窗框、车灯四周的边框。
    inside 是里面那种材质的名字（一个或几个），边画在外面那一侧。
    """
    src = shell.data
    idx = {i for i, m in enumerate(src.materials) if m.name in inside}
    bm = bmesh.new()
    bm.from_mesh(src)
    bm.normal_update()
    edges = []
    for e in bm.edges:
        if len(e.link_faces) != 2:
            continue
        a, b = e.link_faces
        ia, ib = a.material_index in idx, b.material_index in idx
        if ia == ib:
            continue
        edges.append((e, b if ia else a))
    # 每个顶点往"外面那一侧"挪的方向：相邻几条边的平均，带子才是连续的
    out_dir = {}
    normal = {}
    for e, face in edges:
        mid = (e.verts[0].co + e.verts[1].co) / 2
        t = (e.verts[1].co - e.verts[0].co).normalized()
        d = face.calc_center_median() - mid
        d -= t * d.dot(t)
        if d.length < 1e-9:
            continue
        d.normalize()
        n = (e.link_faces[0].normal + e.link_faces[1].normal).normalized()
        for v in e.verts:
            out_dir[v.index] = out_dir.get(v.index, Vector()) + d
            normal[v.index] = normal.get(v.index, Vector()) + n
    mesh = bpy.data.meshes.new(name)
    out = bmesh.new()
    for e, _face in edges:
        v0, v1 = e.verts
        if v0.index not in out_dir or v1.index not in out_dir:
            continue
        quad = []
        ns = []
        for v, k in ((v0, -0.25), (v1, -0.25), (v1, 1.0), (v0, 1.0)):
            d = out_dir[v.index].normalized()
            n = normal[v.index].normalized()
            quad.append(out.verts.new(v.co + n * lift + d * width * k))
            ns.append(n)
        f = out.faces.new(quad)
        f.normal_update()
        if f.normal.dot(ns[0]) < 0:
            f.normal_flip()
        f.smooth = True
    bmesh.ops.remove_doubles(out, verts=list(out.verts), dist=0.0004)
    out.to_mesh(mesh)
    out.free()
    bm.free()
    mesh.materials.append(get_mat(mat))
    return link_mesh(coll, name, mesh, name, body)


def add_arch_lip(coll, body, tree, name, x_sign, y, z, radius, tube=0.013, mat='Paint_Primary', floor=0.0):
    """轮拱边上的一圈唇边：沿着轮拱在车身表面上取点，扫成一根细管。"""
    pts = []
    for i in range(41):
        a = math.radians(-20 + 220 * i / 40)
        py = y - math.cos(a) * radius
        pz = z + math.sin(a) * radius
        if pz < floor:
            continue
        hits = project(tree, [(py, pz)], 'x', x_sign)
        if hits:
            loc, nor = hits[0]
            # 没打在朝外的车身外皮上（打进轮拱里面去了）的点不要
            if nor.x * x_sign < 0.2:
                continue
            pts.append(tuple(loc + nor * 0.002))
    if len(pts) < 4:
        return None
    return add_tube(coll, body, name, pts, tube, mat)


def add_wipers(coll, body, tree, y0, spans, rise=0.07):
    """雨刷：贴着前挡下沿的几根细杆。spans 是 [(x 起, x 止)…]，y0 是前挡下沿稍往上的位置。"""
    for i, (x0, x1) in enumerate(spans):
        path = [(x0, y0), (x1, y0 + rise)]
        hits = project(tree, resample(path, 0.04), 'z')
        if len(hits) < 2:
            continue
        pts = [tuple(p + n * 0.012) for p, n in hits]
        add_tube(coll, body, 'BodyWiper%d' % i, pts, 0.007)
        # 雨刷臂的根部
        add_tube(coll, body, 'BodyWiperArm%d' % i, [tuple(hits[0][0] + hits[0][1] * 0.004), pts[0], tuple((Vector(pts[0]) + Vector(pts[-1])) / 2 + Vector((0, 0, 0.012)))], 0.005)


def add_grille_bars(coll, body, tree, half, zs, mat='Exhaust_Tip', thick=0.012, sign=-1):
    """格栅上的横条。half 是半宽，zs 是每一条的高度。"""
    for i, z in enumerate(zs):
        hits = project(tree, [(0.0, z)], 'y', sign)
        if not hits:
            continue
        y = hits[0][0].y + sign * (thick * 0.5 + 0.002)
        add_box(coll, body, 'BodyGrilleBar%d' % i, (half * 2, thick, thick), (0, y, z), bevel=0.003, mat=mat)


def add_cabin_bits(coll, body, eye, header):
    """车里的小东西：车内后视镜、挡把。header 是前挡上沿的 (y, z)。"""
    add_box(coll, body, 'InteriorMirror', (0.2, 0.025, 0.06), (0, header[0] + 0.14, header[1] - 0.11), rot=(0.25, 0, 0), bevel=0.01, mat='Trim_Black')
    add_box(coll, body, 'InteriorMirrorGlass', (0.18, 0.004, 0.048), (0, header[0] + 0.154, header[1] - 0.113), rot=(0.25, 0, 0), bevel=0.0, mat='Mirror')
    add_box(coll, body, 'InteriorMirrorStem', (0.02, 0.1, 0.02), (0, header[0] + 0.09, header[1] - 0.07), rot=(0.5, 0, 0), bevel=0.004, mat='Trim_Black')
    add_box(coll, body, 'InteriorShifterBase', (0.1, 0.16, 0.02), (0, eye[1] - 0.36, eye[2] - 0.61), bevel=0.006, mat='Trim_Black')
    add_tube(coll, body, 'InteriorShifter', [(0, eye[1] - 0.36, eye[2] - 0.61), (0, eye[1] - 0.34, eye[2] - 0.5)], 0.009, 'Hardware')
    ball = bpy.data.meshes.new('InteriorShifterKnob')
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=14, v_segments=10, radius=0.024)
    for f in bm.faces:
        f.smooth = True
    bm.to_mesh(ball)
    bm.free()
    ball.materials.append(get_mat('Interior_Accent'))
    o = link_mesh(coll, 'InteriorShifterKnob', ball, 'InteriorShifterKnob', body)
    o.location = (0, eye[1] - 0.34, eye[2] - 0.49)


def add_spare_wheel(coll, body, loc, radius, wide=1.0):
    """一个平放着的备胎（从原型车的后轮复制轮胎和轮辋）。"""
    spin = bpy.data.objects['Wheel_RL_Spin']
    k = radius / 0.384
    base = Matrix.Translation(Vector(loc)) @ Matrix.Rotation(math.pi / 2, 4, 'Y') @ Matrix.Diagonal((k * wide, k, k, 1.0))
    for c in spin.children:
        if 'BrakeDisc' in c.name:
            continue
        o = c.copy()
        coll.objects.link(o)
        o.parent = body
        o.matrix_parent_inverse = Matrix.Identity(4)
        o.matrix_world = base @ spin.matrix_world.inverted() @ c.matrix_world
        o['export_name'] = 'BodySpare' + ('Tire' if 'Tire' in c.name else 'Rim')


# ---------------------------------------------------------------- 车尾的细节


def plain_mat(name, color, rough, metal=0.0):
    """游戏里不做特殊处理的材质（尾灯壳、反光片、倒车灯的灯罩）：按这里给的颜色和光泽原样导出。"""
    m = get_mat(name)
    bsdf = next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    for sock in bsdf.inputs:
        if sock.identifier == 'Base Color':
            sock.default_value = (color[0], color[1], color[2], 1.0)
        elif sock.identifier == 'Roughness':
            sock.default_value = rough
        elif sock.identifier == 'Metallic':
            sock.default_value = metal
    return m


def rear_materials():
    """车尾用到的几种新材质。每次生成前调一次，保证颜色是这里写的。"""
    # 尾灯的黑色灯壳：亮黑
    plain_mat('Lamp_Housing', (0.008, 0.008, 0.01), 0.16)
    # 不发光的红色反光片、灯罩
    plain_mat('Lens_Red', (0.36, 0.006, 0.008), 0.1)
    # 倒车灯：带反光碗的白色灯罩
    plain_mat('Lens_Clear', (0.8, 0.82, 0.85), 0.08, 0.7)
    # 后挡玻璃上的除雾丝
    plain_mat('Defrost_Line', (0.2, 0.09, 0.04), 0.5, 0.6)


def text_mesh(name, text, size, depth, mat, bold=0.0, shear=0.0, spacing=1.0):
    """
    一行立体字（字标）。平躺在本地 XY 平面上，从 z=0 鼓到 z=depth，以字的中心为原点。
    用的是 Blender 自带的字体；bold 把笔画加粗（相对字号的比例），shear 是斜体的倾斜量。
    """
    cu = bpy.data.curves.new(name + '_font', 'FONT')
    cu.body = text
    cu.size = size
    cu.extrude = depth / 2
    cu.offset = bold * size
    cu.shear = shear
    cu.space_character = spacing
    cu.align_x = 'CENTER'
    cu.align_y = 'CENTER'
    cu.resolution_u = 3
    tmp = bpy.data.objects.new(name + '_tmp', cu)
    bpy.context.scene.collection.objects.link(tmp)
    bpy.context.view_layer.update()
    mesh = bpy.data.meshes.new_from_object(tmp.evaluated_get(bpy.context.evaluated_depsgraph_get()))
    bpy.data.objects.remove(tmp, do_unlink=True)
    bpy.data.curves.remove(cu)
    mesh.name = name
    for v in mesh.vertices:
        v.co.z += depth / 2
    mesh.materials.clear()
    mesh.materials.append(get_mat(mat))
    return mesh


def ring_mesh(name, radius, tube, mat, segments=28, sides=8):
    """一个圆环（尾灯的光圈、拖车环）。躺在本地 XY 平面上。"""
    pts = [(math.cos(i / segments * 2 * math.pi) * radius, math.sin(i / segments * 2 * math.pi) * radius, 0.0) for i in range(segments)]
    return tube_mesh(name, pts, tube, mat, sides, True)


def rear_frame(n):
    """贴在车尾表面上的部件的朝向：本地 +Z 沿表面法线朝外，+Y 朝上，+X 朝观察者的右手边（车的右侧）。"""
    z = Vector(n).normalized()
    x = Vector((0, 0, 1)).cross(z)
    if x.length < 1e-4:
        x = Vector((-1, 0, 0))
    x.normalize()
    y = z.cross(x).normalized()
    return Matrix((x, y, z)).transposed().to_4x4()


def add_rear(coll, body, tree, name, mesh, x, z, lift=0.0, flat=False, roll=0.0, sharp=50):
    """
    把一个小部件贴到车尾上：从正后方看过去，它在 (x, z) 的位置（x 是车身坐标，左侧为正）。
    默认顺着表面的朝向贴；flat=True 时不管表面怎么斜，都正对车后。lift 是离开表面多远。
    """
    hits = project(tree, [(x, z)], 'y', 1)
    if not hits:
        return None
    loc, nor = hits[0]
    if flat:
        nor = Vector((0, 1, 0))
    o = link_mesh(coll, name, mesh, name, body)
    m = rear_frame(nor)
    if roll:
        m = m @ Matrix.Rotation(roll, 4, 'Z')
    o.matrix_basis = Matrix.Translation(loc + nor * lift) @ m
    if sharp:
        mark_sharp(o, sharp)
    return o


def rear_box(coll, body, tree, name, size, x, z, mat, proud=None, bevel=0.004, flat=False, roll=0.0):
    """车尾上的一个小方块（灯条、反光片、徽标底板）。size = (宽, 高, 厚)；proud 是露出表面多少（默认整块露出来）。"""
    d = size[2]
    lift = d / 2 - (d - proud if proud is not None else 0.0)
    return add_rear(coll, body, tree, name, box_mesh(name, size, bevel, 2, mat), x, z, lift, flat, roll)


def rear_disc(coll, body, tree, name, radius, depth, x, z, mat, proud=None, segments=24):
    lift = depth / 2 - (depth - proud if proud is not None else 0.0)
    return add_rear(coll, body, tree, name, cylinder_mesh(name, radius, depth, mat, 'Z', segments), x, z, lift)


def rear_text(coll, body, tree, name, text, size, x, z, mat='Exhaust_Tip', depth=0.007, bold=0.012, shear=0.0, spacing=1.0, flat=False):
    """车尾上的立体字标。"""
    o = add_rear(coll, body, tree, name, text_mesh(name, text, size, depth, mat, bold, shear, spacing), x, z, 0.0005, flat, sharp=0)
    if o:
        for p in o.data.polygons:
            p.use_smooth = False
    return o


def add_surface_tube(coll, body, tree, name, path, axis, sign=1, radius=0.01, mat='Exhaust_Tip', lift=None, step=0.03, sides=8):
    """顺着车身表面走的一根圆条（镀铬饰条、保险杠上的亮条、灯带）：比贴在表面上的带子有厚度。"""
    hits = project(tree, resample(path, step), axis, sign)
    if len(hits) < 2:
        return None
    off = radius * 0.6 if lift is None else lift
    pts = [loc + nor * off for loc, nor in hits]
    o = link_mesh(coll, name, tube_mesh(name, pts, radius, mat, sides, False), name, body)
    mark_sharp(o, 60)
    return o


def add_defroster(coll, body, tree, half, z0, z1, n=7):
    """后挡玻璃上的除雾丝：一排细细的横线。"""
    for i in range(n):
        z = z0 + (z1 - z0) * i / (n - 1)
        add_seam(coll, body, tree, 'BodyDefrost%d' % i, [(-half, z), (half, z)], 'y', 1, width=0.0035, lift=0.0012, mat='Defrost_Line', step=0.06)


def add_reflectors(coll, body, tree, x, z, size=(0.11, 0.028, 0.008), roll=0.0):
    """后保险杠两角的红色反光片。"""
    for s, tag in ((1, 'L'), (-1, 'R')):
        rear_box(coll, body, tree, 'BodyReflector' + tag, size, s * x, z, 'Lens_Red', proud=0.004, bevel=0.002, roll=roll * s)


def add_tow_loop(coll, body, tree, name, x, z, radius=0.032, mat='Caliper'):
    """拖车环：一个立着的环，根部一小块底座。"""
    hits = project(tree, [(x, z)], 'y', 1)
    if not hits:
        return
    loc, _nor = hits[0]
    ring = link_mesh(coll, name, ring_mesh(name, radius, 0.008, mat, 20, 8), name, body)
    # 环立在竖直平面里、顺着车身前后方向
    ring.matrix_basis = Matrix.Translation(loc + Vector((0, radius * 0.7, 0))) @ Matrix.Rotation(math.pi / 2, 4, 'Y')
    mark_sharp(ring, 60)


# ---------------------------------------------------------------- 导出


def export_car(car_id, filename):
    coll = bpy.data.collections['Car_' + car_id]
    objs = list(coll.objects)
    wanted = {o: o.get('export_name', o.name) for o in objs}
    saved = {o: o.name for o in bpy.data.objects}
    # 先把所有对象改成不会撞名的临时名字，再给这台车的对象起正式的名字
    for i, o in enumerate(bpy.data.objects):
        o.name = '__tmp_%04d' % i
    for o, n in wanted.items():
        o.name = n
    # 代码生成的网格没有贴图坐标：补一套按位置平铺的，免得游戏里的材质取不到
    for o in objs:
        if o.type == 'MESH' and len(o.data.uv_layers) == 0:
            uv = o.data.uv_layers.new(name='UVMap')
            for poly in o.data.polygons:
                for li in poly.loop_indices:
                    co = o.data.vertices[o.data.loops[li].vertex_index].co
                    uv.data[li].uv = (co.x * 0.5 + 0.5, co.y * 0.25 + 0.5)
    for o in bpy.context.selected_objects:
        o.select_set(False)
    for o in objs:
        o.hide_set(False)
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    try:
        bpy.ops.export_scene.gltf(filepath=EXPORT_DIR + filename, export_format='GLB', use_selection=True, export_apply=True, export_yup=True, export_extras=False, export_animations=False)
    finally:
        for o, n in saved.items():
            o.name = '__back_' + n
        for o, n in saved.items():
            o.name = n
    return EXPORT_DIR + filename
