"""
三台新车的具体造型。先执行 build_cars.py（通用的生成工具），再执行本文件，然后调用 build_brute() 等。
"""


def _st(y, zb, zs, zt, w, **kw):
    d = {'y': y, 'zb': zb, 'zs': zs, 'zt': zt, 'w': w}
    d.update(kw)
    return d


def _make_car(car_id, stations, rules, wheels, well, eye, dash, lining, creases, ring_creases, cap_bulge=(0.05, 0.04), cap_c=0.5, extra_cutters=(), end_crease=0.35, wide=None, offroad=0.0, firewall=0.02, lamp_bezel='Trim_Black'):
    """车身壳 + 内衬 + 车轮 + 座舱。返回 (集合, Body 节点, 车壳, 表面查询结构)。"""
    rear_materials()
    coll = collection_for(car_id)
    root = new_empty(coll, 'Car_' + car_id, 'Car')
    body = new_empty(coll, 'Body_' + car_id, 'Body', root)

    shell_mesh = build_shell('Shell_' + car_id, stations, rules, crease_rows=creases, ring_creases=ring_creases, cap_bulge=cap_bulge, cap_c=cap_c, end_crease=end_crease)
    shell = link_mesh(coll, 'BodyShell_' + car_id, shell_mesh, 'BodyShell', body)
    finish_mesh(shell, 2, ())

    # 内衬：把细分好的车壳原样复制一份、去掉玻璃和车灯、翻过来朝里、往里缩一点点。
    # 车窗的轮廓和车壳完全一致，从车里往外看不会在窗框边上露出车壳的背面
    y0 = stations[lining[0]]['y'] - 0.04
    y1 = stations[lining[1]]['y'] + 0.04
    belt = sum(st['zs'] for st in stations[lining[0]:lining[1] + 1]) / (lining[1] - lining[0] + 1)
    # 防火墙往前挪了的话，内衬也跟着往前接到它那里，中间不留空当
    lin_mesh = make_lining(shell.data, 'Lining_' + car_id, min(y0, y0 + firewall - 0.03), y1, belt)
    link_mesh(coll, 'InteriorLining_' + car_id, lin_mesh, 'InteriorLining', body)
    # 前面的防火墙、后面的隔板：把发动机舱和后备箱挡住。形状跟着那一处的车身横截面走
    link_mesh(coll, 'InteriorFirewall', section_cap('InteriorFirewall', stations[lining[0]], y0 + firewall), 'InteriorFirewall', body)
    link_mesh(coll, 'InteriorBulkhead', section_cap('InteriorBulkhead', stations[lining[1]], y1 - 0.02), 'InteriorBulkhead', body)

    # 车窗四周的黑色窗框、车灯四周的边框：趁还没挖轮拱先做（挖完以后面的编号会变）
    boundary_trim(coll, body, shell, 'BodyWindowTrim', ('Glass',), width=0.016)
    boundary_trim(coll, body, shell, 'BodyLampBezel', ('Light_Head', 'Light_Tail', 'Light_Signal', 'Lamp_Housing'), width=0.011, lift=0.002, mat=lamp_bezel)

    cutters = []
    for tag, (x, y, r) in wheels.items():
        cutters.append(temp_cylinder(r + well, 0.62, (x, y, r), 'Trim_Black'))
    cutters += list(extra_cutters)
    finish_mesh(shell, 0, cutters)
    for c in cutters:
        bpy.data.objects.remove(c, do_unlink=True)

    made = copy_wheels(coll, root, wheels, wide)
    if offroad:
        r = next(iter(wheels.values()))[2]
        fit_offroad_tires(coll, made, r, offroad)
    add_cockpit(coll, body, eye, dash)
    add_anchor(coll, body, 'Cam_Cockpit', eye)
    return coll, body, shell, surface_tree(shell)


def _door(coll, body, tree, y0, y1, z0, z1, handle, handle_mat='Trim_Black'):
    """两侧的车门缝和门把手。y0–y1 是车门前后沿，z0–z1 是下沿和上沿（上沿接着车窗）。"""
    path = fillet([(y0, z1), (y0, z0), (y1, z0), (y1, z1)], 0.06)
    add_seam_both(coll, body, tree, 'BodyDoorSeam', path)
    for s, tag in ((1, 'L'), (-1, 'R')):
        add_on_surface(coll, body, tree, 'BodyDoorHandle' + tag, box_mesh('BodyDoorHandle' + tag, (0.024, 0.13, 0.016), 0.006, 2, handle_mat), handle, 'x', s, lift=0.006)


def _hood(coll, body, tree, x, y_rear, y_front):
    """发动机盖的缝：两条纵缝加车头的一条横缝。"""
    add_seam(coll, body, tree, 'BodyHoodSeam', fillet([(x, y_rear), (x, y_front), (-x, y_front), (-x, y_rear)], 0.07), 'z')


def _ball(coll, body, name, radius, loc, mat, scale=(1, 1, 1)):
    """一个球（拖车球头、后桥的差速器壳）。"""
    mesh = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=18, v_segments=12, radius=radius)
    for f in bm.faces:
        f.smooth = True
    bm.to_mesh(mesh)
    bm.free()
    mesh.materials.append(get_mat(mat))
    o = link_mesh(coll, name, mesh, name, body)
    o.location = loc
    o.scale = scale
    return o


def _brute_rear(coll, body, tree):
    """
    BRUTE 的车尾：一整条亮黑的灯板，两边各三根竖着的尾灯（老肌肉车的样子），中间是镀铬的车名；
    后备箱沿上一道鸭尾，保险杠上一根镀铬亮条。
    """
    zc = 0.847
    for s, tag in ((1, 'L'), (-1, 'R')):
        # 三根竖灯，外侧再加一根细的琥珀色转向灯
        for i, x in enumerate((0.47, 0.6, 0.73)):
            rear_box(coll, body, tree, 'BodyTailBar%s%d' % (tag, i), (0.094, 0.108, 0.016), s * x, zc, 'Light_Tail', proud=0.009, bevel=0.007)
        rear_box(coll, body, tree, 'BodyTailTurn' + tag, (0.026, 0.108, 0.014), s * 0.822, zc, 'Light_Signal', proud=0.007, bevel=0.005)
        # 倒车灯
        rear_box(coll, body, tree, 'BodyReverse' + tag, (0.07, 0.052, 0.012), s * 0.34, zc, 'Lens_Clear', proud=0.006, bevel=0.005)
        # 三根竖灯外面一圈镀铬细框
        add_surface_tube(coll, body, tree, 'BodyTailFrame' + tag, fillet([(s * 0.405, zc - 0.066), (s * 0.795, zc - 0.066), (s * 0.795, zc + 0.066), (s * 0.405, zc + 0.066), (s * 0.405, zc - 0.066)], 0.02), 'y', 1, radius=0.0045, lift=0.004)
        # 后翼子板侧面的红色示廓灯
        add_on_surface(coll, body, tree, 'BodySideMarker' + tag, box_mesh('BodySideMarker' + tag, (0.032, 0.11, 0.008), 0.003, 2, 'Lens_Red'), (2.22, 0.74), 'x', s, lift=0.003)
    # 车名是发光的字标（和原型车车尾的做法一样）：镀铬的字在夜里、在黑色灯板上几乎看不见
    rear_text(coll, body, tree, 'BodyBadgeName', 'BRUTE', 0.078, 0.0, zc, 'Light_TailBadge', depth=0.008, bold=0.022, spacing=1.3)
    # 高位刹车灯：灯板上方的一条
    rear_box(coll, body, tree, 'BodyBrakeLightHigh', (0.38, 0.015, 0.012), 0.0, 0.968, 'Light_TailBar', proud=0.006, bevel=0.003)
    # 车牌上面的牌照灯罩、车牌后面一块黑色的凹框
    rear_box(coll, body, tree, 'BodyPlateLamp', (0.2, 0.02, 0.022), 0.0, 0.738, 'Exhaust_Tip', proud=0.016, bevel=0.005)
    rear_box(coll, body, tree, 'BodyPlateRecess', (0.46, 0.15, 0.008), 0.0, 0.66, 'Trim_Black', proud=0.004, bevel=0.003)
    rear_text(coll, body, tree, 'BodyBadgeV8', 'V8', 0.05, -0.62, 0.665, 'Exhaust_Tip', depth=0.007, bold=0.03, shear=0.28)
    # 保险杠：漆面和黑色下包围交界处一根镀铬亮条
    add_surface_tube(coll, body, tree, 'BodyBumperChrome', [(-0.82, 0.578), (0.82, 0.578)], 'y', 1, radius=0.015, lift=0.008, step=0.05)
    add_reflectors(coll, body, tree, 0.74, 0.49)
    # 黑色下包围上两组散热格栅：几根横着的灰色叶片
    for s, tag in ((1, 'L'), (-1, 'R')):
        for i in range(4):
            rear_box(coll, body, tree, 'BodyValanceSlat%s%d' % (tag, i), (0.34, 0.012, 0.012), s * 0.38, 0.405 + i * 0.03, 'Mechanical', proud=0.007, bevel=0.003)
        add_surface_tube(coll, body, tree, 'BodyValanceFrame' + tag, fillet([(s * 0.19, 0.385), (s * 0.57, 0.385), (s * 0.57, 0.515), (s * 0.19, 0.515), (s * 0.19, 0.385)], 0.02), 'y', 1, radius=0.004, mat='Mechanical', lift=0.003)
    # 鸭尾：后备箱后沿翘起来的一道，下面压一条黑边
    add_box(coll, body, 'BodyDucktail', (1.5, 0.2, 0.03), (0, 2.405, 1.058), rot=(0.34, 0, 0), bevel=0.012, mat='Paint_Primary', taper=(0.985, 0.9))
    add_box(coll, body, 'BodyDucktailLip', (1.46, 0.014, 0.022), (0, 2.502, 1.083), rot=(0.34, 0, 0), bevel=0.003)
    # 后翼子板上的天线
    add_tube(coll, body, 'BodyAntenna', [(0.8, 2.02, 1.0), (0.8, 2.13, 1.7)], 0.0045, 'Hardware')
    add_tube(coll, body, 'BodyAntennaBase', [(0.8, 2.012, 0.985), (0.8, 2.03, 1.03)], 0.012, 'Trim_Black')


def _ronin_rear(coll, body, tree):
    """
    RONIN 的车尾：两边各两个圆环尾灯，中间一条亮黑饰板上是贯穿的细灯带和镀铬车名；
    车顶尾翼后沿有高位刹车灯，后挡有除雾丝，保险杠上有反光片、后雾灯和拖车环。
    """
    zc = 0.813
    for s, tag in ((1, 'L'), (-1, 'R')):
        for i, x in enumerate((0.535, 0.7)):
            add_rear(coll, body, tree, 'BodyTailRing%s%d' % (tag, i), ring_mesh('BodyTailRing%s%d' % (tag, i), 0.055, 0.0095, 'Light_Tail'), s * x, zc, 0.007, sharp=60)
            rear_disc(coll, body, tree, 'BodyTailCore%s%d' % (tag, i), 0.034, 0.01, s * x, zc, 'Lens_Red', proud=0.005)
            rear_disc(coll, body, tree, 'BodyTailDot%s%d' % (tag, i), 0.011, 0.014, s * x, zc, 'Light_Tail', proud=0.01, segments=14)
        rear_box(coll, body, tree, 'BodyTailTurn' + tag, (0.022, 0.116, 0.014), s * 0.805, zc, 'Light_Signal', proud=0.007, bevel=0.005)
        rear_box(coll, body, tree, 'BodyReverse' + tag, (0.03, 0.1, 0.012), s * 0.425, zc, 'Lens_Clear', proud=0.006, bevel=0.004)
        # 保险杠两角竖着的反光片
        rear_box(coll, body, tree, 'BodyReflector' + tag, (0.03, 0.095, 0.008), s * 0.74, 0.43, 'Lens_Red', proud=0.004, bevel=0.002)
    # 贯穿的细灯带、车名
    add_surface_tube(coll, body, tree, 'BodyTailStrip', [(-0.37, zc + 0.058), (0.37, zc + 0.058)], 'y', 1, radius=0.006, mat='Light_TailBar', lift=0.003, step=0.05)
    rear_text(coll, body, tree, 'BodyBadgeName', 'RONIN', 0.064, 0.0, zc - 0.014, 'Light_TailBadge', depth=0.007, bold=0.022, spacing=1.35)
    # 尾门拉手（里面藏着牌照灯）、两个小字标
    rear_box(coll, body, tree, 'BodyHatchHandle', (0.3, 0.024, 0.022), 0.0, 0.668, 'Trim_Black', proud=0.016, bevel=0.006)
    rear_text(coll, body, tree, 'BodyBadgeAwd', 'AWD', 0.042, -0.6, 0.652, 'Exhaust_Tip', depth=0.006, bold=0.03, shear=0.25)
    rear_text(coll, body, tree, 'BodyBadgeTurbo', 'TURBO', 0.03, 0.6, 0.652, 'Exhaust_Tip', depth=0.006, bold=0.02, spacing=1.15)
    # 后雾灯、拖车环
    rear_box(coll, body, tree, 'BodyRearFog', (0.13, 0.034, 0.012), 0.0, 0.43, 'Light_TailBar', proud=0.006, bevel=0.004)
    add_tow_loop(coll, body, tree, 'BodyTowLoop', -0.44, 0.37)
    # 尾翼：后沿一条高位刹车灯，再压一道黑色的扰流条
    add_box(coll, body, 'BodyBrakeLightHigh', (0.5, 0.014, 0.012), (0, 1.834, 1.372), rot=(-0.16, 0, 0), bevel=0.003, mat='Light_TailBar')
    add_box(coll, body, 'BodyRoofWingGurney', (1.32, 0.012, 0.032), (0, 1.826, 1.392), rot=(-0.16, 0, 0), bevel=0.003)
    # 后挡：除雾丝、雨刷的转轴盖
    add_defroster(coll, body, tree, 0.58, 1.0, 1.3, 7)
    rear_disc(coll, body, tree, 'BodyWiperPivot', 0.02, 0.022, 0.0, 1.055, 'Trim_Black', proud=0.018, segments=16)
    # 车顶的鲨鱼鳍天线
    add_box(coll, body, 'BodySharkFin', (0.05, 0.2, 0.07), (0, 1.28, 1.44), rot=(0.0, 0, 0), bevel=0.012, mat='Paint_Secondary', taper=(0.35, 0.3))


def _nomad_rear(coll, body, tree, r):
    """
    NOMAD 的车尾：尾门两侧立式的三段尾灯（红、琥珀、白），尾门上压着一排大字；
    后保险杠上有防滑踏板、反光片、拖车钩和两个拖车环，车牌挂在保险杠中间；
    从后面能看到底下的后桥、差速器和两根减震筒。
    """
    for s, tag in ((1, 'L'), (-1, 'R')):
        x = s * 0.862
        rear_box(coll, body, tree, 'BodyTailHousing' + tag, (0.118, 0.32, 0.03), x, 1.06, 'Lamp_Housing', proud=0.016, bevel=0.01)
        rear_box(coll, body, tree, 'BodyTailStop' + tag, (0.086, 0.125, 0.018), x, 1.142, 'Light_Tail', proud=0.026, bevel=0.007)
        rear_box(coll, body, tree, 'BodyTailTurn' + tag, (0.086, 0.062, 0.016), x, 1.038, 'Light_Signal', proud=0.024, bevel=0.006)
        rear_box(coll, body, tree, 'BodyReverse' + tag, (0.086, 0.062, 0.016), x, 0.962, 'Lens_Clear', proud=0.024, bevel=0.006)
        # 保险杠两头的反光片、拖车环、踏板上的防滑条
        add_box(coll, body, 'BodyReflector' + tag, (0.13, 0.008, 0.036), (s * 0.84, 2.752, 0.74), bevel=0.002, mat='Lens_Red')
        ring = link_mesh(coll, 'BodyShackle' + tag, ring_mesh('BodyShackle' + tag, 0.04, 0.011, 'Caliper', 20, 8), 'BodyShackle' + tag, body)
        ring.matrix_basis = Matrix.Translation(Vector((s * 0.5, 2.775, 0.705))) @ Matrix.Rotation(math.pi / 2, 4, 'Y')
        mark_sharp(ring, 60)
        add_box(coll, body, 'BodyShackleMount' + tag, (0.07, 0.03, 0.06), (s * 0.5, 2.752, 0.74), bevel=0.006, mat='Mechanical')
        for i in range(6):
            add_box(coll, body, 'BodyStepRib' + tag, (0.36, 0.013, 0.012), (s * 0.62, 2.595 + i * 0.026, 0.824), bevel=0.003, mat='Mechanical')
        # 减震筒：从后桥斜着接到车架上（颜色跟着卡钳走）
        add_tube(coll, body, 'BodyShock' + tag, [(s * 0.56, 1.6, r + 0.02), (s * 0.5, 1.48, 0.9)], 0.03, 'Caliper')
        add_tube(coll, body, 'BodyShockRod' + tag, [(s * 0.5, 1.48, 0.9), (s * 0.48, 1.44, 1.0)], 0.014, 'Exhaust_Tip')
        # 钢板弹簧
        add_box(coll, body, 'BodyLeafSpring' + tag, (0.07, 1.0, 0.035), (s * 0.62, 1.66, r + 0.075), bevel=0.006, mat='Mechanical')
        # 驾驶室后窗的推拉窗框
        add_seam(coll, body, tree, 'BodySliderFrame' + tag, [(s * 0.25, 1.34), (s * 0.25, 1.8)], 'y', 1, width=0.014)
    # 尾门上的大字：和副色同一种漆，凸出来一点
    rear_text(coll, body, tree, 'BodyBadgeName', 'NOMAD', 0.15, 0.0, 1.0, 'Paint_Secondary', depth=0.009, bold=0.035, spacing=1.32)
    # 尾门上下两道压出来的棱
    for i, z in enumerate((0.9, 1.205)):
        add_seam(coll, body, tree, 'BodyTailgateRib%d' % i, [(-0.7, z), (0.7, z)], 'y', 1, width=0.006)
    # 拖车钩：方管接头、插杆、球头
    add_box(coll, body, 'BodyHitch', (0.11, 0.2, 0.1), (0, 2.7, 0.6), bevel=0.012, mat='Mechanical')
    add_box(coll, body, 'BodyHitchBar', (0.055, 0.2, 0.05), (0, 2.82, 0.6), bevel=0.008, mat='Mechanical')
    add_tube(coll, body, 'BodyHitchNeck', [(0, 2.89, 0.62), (0, 2.89, 0.665)], 0.013, 'Exhaust_Tip')
    _ball(coll, body, 'BodyHitchBall', 0.03, (0, 2.89, 0.685), 'Exhaust_Tip')
    # 驾驶室顶后沿的高位刹车灯
    add_box(coll, body, 'BodyBrakeLightHigh', (0.36, 0.022, 0.02), (0, 0.9, 1.872), bevel=0.004, mat='Light_TailBar')
    # 防滚架上两盏朝后的工作灯
    for x in (-0.34, 0.34):
        lamp = link_mesh(coll, 'BodyWorkLamp', cylinder_mesh('BodyWorkLamp', 0.06, 0.07, 'Trim_Black', 'Y', 20, inner=0.05, inner_mat='Lens_Clear'), 'BodyWorkLamp', body)
        lamp.location = (x, 1.15, 1.975)
        mark_sharp(lamp, 40)
    # 货斗底板的防滑筋
    for i in range(9):
        add_box(coll, body, 'BodyBedRib', (0.05, 1.42, 0.014), (-0.6 + i * 0.15, 1.77, 0.827), bevel=0.004, mat='Mechanical')
    # 后桥：一根桥管、中间的差速器壳、往前去的传动轴
    add_tube(coll, body, 'BodyAxle', [(-0.8, 1.66, r), (0.8, 1.66, r)], 0.046, 'Mechanical')
    _ball(coll, body, 'BodyDiff', 0.15, (0.0, 1.66, r), 'Mechanical', scale=(1.0, 1.1, 1.0))
    add_tube(coll, body, 'BodyDriveshaft', [(0, 1.52, r), (0, 0.2, r + 0.1)], 0.032, 'Mechanical')


def build_brute():
    """BRUTE：美式肌肉车。长车头、短车尾、溜背，车身方正厚重，后轮比前轮大一圈。"""
    S = [
        _st(-2.45, 0.31, 0.75, 0.79, 0.90, wb=0.80),
        _st(-2.38, 0.24, 0.81, 0.86, 0.955),
        _st(-2.05, 0.20, 0.86, 0.93, 0.975),
        _st(-1.50, 0.20, 0.89, 0.985, 0.985, flare=0.02),
        _st(-0.95, 0.19, 0.91, 1.01, 0.98),
        _st(-0.42, 0.19, 0.925, 1.02, 0.975),
        _st(0.22, 0.19, 0.935, 1.315, 0.975, g=1.0, wr=0.66),
        _st(0.64, 0.19, 0.94, 1.33, 0.975, g=1.0, wr=0.67),
        _st(0.74, 0.19, 0.94, 1.33, 0.975, g=1.0, wr=0.67),
        _st(1.16, 0.19, 0.95, 1.30, 0.985, g=1.0, wr=0.655),
        _st(1.74, 0.20, 0.975, 1.13, 0.995, g=0.8, wr=0.62, flare=0.03),
        _st(2.10, 0.21, 0.985, 1.035, 0.985),
        _st(2.36, 0.26, 0.975, 1.05, 0.955),
        _st(2.46, 0.36, 0.93, 1.00, 0.905, wb=0.80),
    ]
    R = [
        # 中间一道拉花：发动机盖、车顶、后备箱
        ('band', 0, 4, 9, 9, 'Paint_Secondary'),
        ('band', 6, 8, 9, 9, 'Paint_Secondary'),
        ('band', 11, 12, 9, 9, 'Paint_Secondary'),
        # 前挡
        ('band', 5, 5, 7, 9, 'Glass'),
        # 侧窗（中间隔着 B 柱）
        ('band', 6, 6, 6, 7, 'Glass'),
        ('band', 7, 7, 6, 7, 'Trim_Black'),
        ('band', 8, 8, 6, 7, 'Glass'),
        # 后挡：溜背上的一大块
        ('band', 9, 10, 8, 9, 'Glass'),
        # 车头：中间是格栅，两边是大灯，下面是进气口
        ('front', 0, 0, 3, 4, 'Trim_Black', 1),
        ('front', 0, 0, 4, 4, 'Light_Head', 0),
        ('front', 0, 0, 2, 2, 'Trim_Black'),
        # 车尾：一整条贯穿的亮黑灯板（发光的灯是另外贴上去的），下面是黑色的后包围
        ('rear', 0, 0, 4, 4, 'Lamp_Housing'),
        ('rear', 0, 0, 2, 2, 'Trim_Black'),
        ('band', 12, 12, 2, 2, 'Trim_Black'),
    ]
    wheels = {'FL': (0.83, -1.50, 0.372), 'FR': (-0.83, -1.50, 0.372), 'RL': (0.835, 1.44, 0.392), 'RR': (-0.835, 1.44, 0.392)}
    # 车顶很低：眼睛放低、靠前一些，前挡的开口才够大；仪表屏因此伸到前挡下沿前面一点，防火墙跟着往前挪
    eye = (0.36, 0.52, 1.08)
    coll, body, shell, tree = _make_car(
        'brute', S, R, wheels, 0.072, eye, (-0.39, 0.9), (5, 10),
        creases=((4, 0.3), (5, 0.6), (6, 0.3)),
        ring_creases=((5, 6, 9, 0.75), (6, 8, 9, 0.3), (11, 6, 9, 0.6), (12, 5, 9, 0.8)),
        cap_bulge=(0.03, 0.035), cap_c=0.52,
        wide={'RL': 1.14, 'RR': 1.14}, firewall=-0.13, lamp_bezel='Exhaust_Tip',
    )
    # 前铲、进气鼓包、后扩散器
    add_box(coll, body, 'BodySplitter', (1.66, 0.16, 0.028), (0, -2.37, 0.235), bevel=0.008)
    add_box(coll, body, 'BodyScoop', (0.5, 0.8, 0.075), (0, -1.22, 1.035), rot=(0.035, 0, 0), bevel=0.02, mat='Paint_Secondary', taper=(0.78, 0.86))
    add_box(coll, body, 'BodyScoopMouth', (0.36, 0.03, 0.045), (0, -1.615, 1.03), bevel=0.006)
    add_box(coll, body, 'BodyDiffuser', (1.5, 0.22, 0.13), (0, 2.38, 0.275), bevel=0.02)
    for x in (-0.45, -0.15, 0.15, 0.45):
        add_box(coll, body, 'BodyDiffuserFin', (0.02, 0.24, 0.1), (x, 2.42, 0.25), bevel=0.004)
    add_exhaust(coll, body, [0.63, 0.5, -0.5, -0.63], 2.5, 0.305, 0.05)
    add_mirrors(coll, body, 0.935, -0.2, 1.015)
    add_plate(coll, body, 2.515, 0.66)

    # 车身上的缝和小件
    _door(coll, body, tree, -0.36, 0.80, 0.31, 0.915, (0.62, 0.8), 'Exhaust_Tip')
    _hood(coll, body, tree, 0.8, -0.47, -2.22)
    # 后备箱盖
    add_seam(coll, body, tree, 'BodyTrunkSeam', fillet([(0.76, 2.14), (0.76, 2.345), (-0.76, 2.345), (-0.76, 2.14)], 0.05), 'z')
    # 油箱盖
    add_seam(coll, body, tree, 'BodyFuelCap', circle(1.86, 0.84, 0.068), 'x', 1, width=0.006)
    # 前轮后面的三道散热口
    for i in range(3):
        add_seam_both(coll, body, tree, 'BodyFenderVent%d' % i, [(-0.99 + i * 0.075, 0.545), (-0.905 + i * 0.075, 0.705)], width=0.026)
    # 格栅的镀铬横条、两边的小灯（转向灯）
    add_grille_bars(coll, body, tree, 0.43, [0.5, 0.56, 0.62, 0.68, 0.74], 'Exhaust_Tip', 0.01)
    for s, tag in ((1, 'L'), (-1, 'R')):
        add_on_surface(coll, body, tree, 'BodySignal' + tag, box_mesh('BodySignal' + tag, (0.2, 0.05, 0.012), 0.004, 2, 'Light_Signal'), (s * 0.68, 0.45), 'y', -1, lift=0.004)
        add_arch_lip(coll, body, tree, 'BodyArchLipF' + tag, s, -1.50, 0.372, 0.372 + 0.072 + 0.016, floor=0.22)
        add_arch_lip(coll, body, tree, 'BodyArchLipR' + tag, s, 1.44, 0.392, 0.392 + 0.072 + 0.016, floor=0.22)
    add_wipers(coll, body, tree, -0.37, [(0.03, 0.56), (-0.5, 0.0)])
    # 后挡上的百叶：肌肉车的老样式
    for i in range(5):
        t = i / 4
        y = 1.27 + t * 0.62
        z = 1.285 - t * 0.2
        add_box(coll, body, 'BodyLouver%d' % i, (1.06 - t * 0.06, 0.13, 0.012), (0, y, z + 0.035), rot=(-0.16, 0, 0), bevel=0.003)
    add_cabin_bits(coll, body, eye, (0.22, 1.3))
    _brute_rear(coll, body, tree)

    add_anchor(coll, body, 'FX_Exhaust_L', (0.565, 2.52, 0.305))
    add_anchor(coll, body, 'FX_Exhaust_R', (-0.565, 2.52, 0.305))
    add_anchor(coll, body, 'FX_Headlight_L', (0.72, -2.44, 0.77))
    add_anchor(coll, body, 'FX_Headlight_R', (-0.72, -2.44, 0.77))
    add_anchor(coll, body, 'FX_Taillight_L', (0.62, 2.5, 0.93))
    add_anchor(coll, body, 'FX_Taillight_R', (-0.62, 2.5, 0.93))
    add_anchor(coll, body, 'Cam_Hood', (0, -1.0, 1.2))
    return coll


def build_ronin():
    """RONIN：两厢掀背小钢炮。车短、车顶高、车尾几乎是直的，四个轮子顶在四个角上。"""
    S = [
        _st(-2.03, 0.30, 0.66, 0.70, 0.84, wb=0.76),
        _st(-1.95, 0.22, 0.74, 0.79, 0.90),
        _st(-1.66, 0.19, 0.80, 0.87, 0.925),
        _st(-1.27, 0.19, 0.84, 0.93, 0.935, flare=0.035),
        _st(-0.95, 0.18, 0.87, 0.97, 0.93),
        _st(-0.22, 0.18, 0.89, 1.42, 0.93, g=1.0, wr=0.69),
        _st(0.30, 0.18, 0.90, 1.445, 0.93, g=1.0, wr=0.70),
        _st(0.40, 0.18, 0.90, 1.445, 0.93, g=1.0, wr=0.70),
        _st(1.15, 0.18, 0.91, 1.42, 0.935, g=1.0, wr=0.69),
        _st(1.52, 0.19, 0.92, 1.385, 0.935, g=1.0, wr=0.675, flare=0.035),
        _st(1.92, 0.21, 0.93, 1.02, 0.925, g=0.5, wr=0.66),
        _st(2.04, 0.31, 0.90, 0.96, 0.88, wb=0.78),
    ]
    R = [
        # 黑车顶
        ('band', 5, 8, 8, 9, 'Paint_Secondary'),
        # 下半截一圈黑色包围
        ('band', 0, 99, 2, 2, 'Trim_Black'),
        ('band', 4, 4, 7, 9, 'Glass'),
        ('band', 5, 5, 6, 7, 'Glass'),
        ('band', 6, 6, 6, 7, 'Trim_Black'),
        ('band', 7, 7, 6, 7, 'Glass'),
        ('band', 9, 9, 7, 9, 'Glass'),
        ('front', 0, 0, 3, 4, 'Trim_Black', 1),
        ('front', 0, 0, 4, 4, 'Light_Head', 0),
        ('front', 0, 0, 2, 2, 'Trim_Black'),
        # 车尾：两边是尾灯的亮黑灯壳，中间一块亮黑饰板（圆环灯、灯带、字标是另外贴上去的）
        ('rear', 0, 0, 4, 4, 'Lamp_Housing', 0),
        ('rear', 0, 0, 4, 4, 'Lamp_Housing', 1),
        ('rear', 0, 0, 2, 2, 'Trim_Black'),
    ]
    r = 0.335
    wheels = {'FL': (0.79, -1.27, r), 'FR': (-0.79, -1.27, r), 'RL': (0.79, 1.33, r), 'RR': (-0.79, 1.33, r)}
    eye = (0.34, 0.20, 1.16)
    coll, body, shell, tree = _make_car(
        'ronin', S, R, wheels, 0.065, eye, (-0.92, 0.86), (4, 10),
        creases=((4, 0.2), (5, 0.6), (6, 0.3)),
        ring_creases=((4, 6, 9, 0.75), (5, 8, 9, 0.3), (9, 6, 9, 0.5), (10, 5, 9, 0.7)),
        cap_bulge=(0.05, 0.03), cap_c=0.5,
    )
    add_box(coll, body, 'BodySplitter', (1.56, 0.14, 0.026), (0, -1.965, 0.225), bevel=0.008)
    # 车顶尾翼：一块翼板、两片端板、两根支撑
    add_box(coll, body, 'BodyRoofWing', (1.32, 0.34, 0.028), (0, 1.66, 1.4), rot=(-0.16, 0, 0), bevel=0.008, mat='Paint_Secondary')
    for s in (1, -1):
        add_box(coll, body, 'BodyRoofWingEnd', (0.02, 0.36, 0.1), (s * 0.66, 1.66, 1.385), rot=(-0.16, 0, 0), bevel=0.004)
        add_box(coll, body, 'BodyRoofWingStay', (0.02, 0.2, 0.07), (s * 0.4, 1.58, 1.375), rot=(-0.3, 0, 0), bevel=0.004)
        add_box(coll, body, 'BodySkirt', (0.05, 1.86, 0.05), (s * 0.885, 0.03, 0.215), bevel=0.012)
    add_box(coll, body, 'BodyDiffuser', (1.3, 0.16, 0.12), (0, 1.98, 0.28), bevel=0.02)
    for x in (-0.36, -0.12, 0.12, 0.36):
        add_box(coll, body, 'BodyDiffuserFin', (0.018, 0.2, 0.09), (x, 2.01, 0.255), bevel=0.004)
    add_exhaust(coll, body, [0.09, -0.09], 2.07, 0.3, 0.046)
    add_mirrors(coll, body, 0.89, -0.72, 0.99)
    add_plate(coll, body, 2.085, 0.56)

    # 三门掀背：一侧一个长车门
    _door(coll, body, tree, -0.80, 0.44, 0.3, 0.875, (0.28, 0.78))
    _hood(coll, body, tree, 0.77, -1.0, -1.8)
    # 发动机盖上的两道散热口
    for s, tag in ((1, 'L'), (-1, 'R')):
        add_seam(coll, body, tree, 'BodyHoodVent' + tag, [(s * 0.3, -1.5), (s * 0.34, -1.2)], 'z', width=0.05)
        # 前杠两角的圆雾灯
        add_on_surface(coll, body, tree, 'BodyFogLamp' + tag, cylinder_mesh('BodyFogLamp' + tag, 0.05, 0.02, 'Light_Head', 'Z', 20), (s * 0.6, 0.36), 'y', -1, lift=0.006)
        add_on_surface(coll, body, tree, 'BodyFogRing' + tag, cylinder_mesh('BodyFogRing' + tag, 0.062, 0.014, 'Trim_Black', 'Z', 20), (s * 0.6, 0.36), 'y', -1, lift=0.002)
        # 黑色的轮眉（比车身色的唇边粗，像后装的宽体包围）
        add_arch_lip(coll, body, tree, 'BodyArchLipF' + tag, s, -1.27, r, r + 0.065 + 0.022, tube=0.022, mat='Trim_Black', floor=0.21)
        add_arch_lip(coll, body, tree, 'BodyArchLipR' + tag, s, 1.33, r, r + 0.065 + 0.022, tube=0.022, mat='Trim_Black', floor=0.21)
        # 挡泥板
        for y in (-1.27 + r + 0.09, 1.33 + r + 0.09):
            add_box(coll, body, 'BodyMudFlap', (0.2, 0.015, 0.17), (s * 0.82, y, 0.255), rot=(0.12, 0, 0), bevel=0.004, mat='Paint_Secondary')
    # 尾门的缝
    add_seam(coll, body, tree, 'BodyHatchSeam', fillet([(0.66, 0.92), (0.66, 0.46), (-0.66, 0.46), (-0.66, 0.92)], 0.05), 'y', 1)
    add_seam(coll, body, tree, 'BodyFuelCap', circle(0.72, 0.72, 0.062), 'x', -1, width=0.006)
    add_grille_bars(coll, body, tree, 0.4, [0.5, 0.58, 0.66], 'Mechanical', 0.012)
    add_wipers(coll, body, tree, -0.9, [(0.03, 0.52), (-0.46, 0.0)])
    # 后雨刷
    add_seam(coll, body, tree, 'BodyRearWiper', [(0.0, 1.06), (0.34, 1.1)], 'y', 1, width=0.014, lift=0.012)
    # 座椅后面的半个防滚架
    add_tube(coll, body, 'InteriorCageHoop', [(-0.6, 0.66, 0.26), (-0.6, 0.66, 1.2), (-0.5, 0.66, 1.33), (0.5, 0.66, 1.33), (0.6, 0.66, 1.2), (0.6, 0.66, 0.26)], 0.022, 'Hardware')
    add_tube(coll, body, 'InteriorCageDiag', [(-0.58, 0.67, 0.3), (0.56, 0.67, 1.26)], 0.018, 'Hardware')
    for s in (1, -1):
        add_tube(coll, body, 'InteriorCageStay', [(s * 0.55, 0.68, 1.3), (s * 0.6, 1.45, 0.82)], 0.018, 'Hardware')
    add_cabin_bits(coll, body, eye, (-0.22, 1.41))
    _ronin_rear(coll, body, tree)

    add_anchor(coll, body, 'FX_Exhaust_L', (0.09, 2.09, 0.3))
    add_anchor(coll, body, 'FX_Exhaust_R', (-0.09, 2.09, 0.3))
    add_anchor(coll, body, 'FX_Headlight_L', (0.68, -2.02, 0.7))
    add_anchor(coll, body, 'FX_Headlight_R', (-0.68, -2.02, 0.7))
    add_anchor(coll, body, 'FX_Taillight_L', (0.7, 2.07, 0.86))
    add_anchor(coll, body, 'FX_Taillight_R', (-0.7, 2.07, 0.86))
    add_anchor(coll, body, 'Cam_Hood', (0, -0.85, 1.14))
    return coll


def build_nomad():
    """NOMAD：越野皮卡。又高又方，轮子大了一圈，底盘离地半米；车头有防撞杠，车顶一排射灯，货斗里立着防滚架。"""
    S = [
        _st(-2.63, 0.62, 1.02, 1.07, 0.92, wb=0.84),
        _st(-2.55, 0.54, 1.10, 1.16, 0.98),
        _st(-2.20, 0.52, 1.16, 1.23, 1.0),
        _st(-1.62, 0.52, 1.19, 1.27, 1.0, flare=0.07),
        _st(-1.00, 0.52, 1.21, 1.30, 1.0),
        _st(-0.72, 0.52, 1.22, 1.31, 1.0),
        _st(-0.20, 0.52, 1.23, 1.86, 1.0, g=1.0, wr=0.78),
        _st(0.28, 0.52, 1.23, 1.885, 1.0, g=1.0, wr=0.79),
        _st(0.38, 0.52, 1.23, 1.885, 1.0, g=1.0, wr=0.79),
        _st(0.86, 0.52, 1.24, 1.87, 1.0, g=1.0, wr=0.78),
        _st(1.0, 0.52, 1.25, 1.29, 1.0),
        _st(1.66, 0.52, 1.25, 1.29, 1.0, flare=0.07),
        _st(2.52, 0.54, 1.25, 1.29, 0.99),
        _st(2.64, 0.62, 1.20, 1.25, 0.95, wb=0.86),
    ]
    R = [
        ('band', 0, 99, 2, 2, 'Trim_Black'),
        # 发动机盖中间一块深色的防眩板
        ('band', 2, 4, 8, 9, 'Paint_Secondary'),
        ('band', 5, 5, 7, 9, 'Glass'),
        ('band', 6, 6, 6, 7, 'Glass'),
        ('band', 7, 7, 6, 7, 'Trim_Black'),
        ('band', 8, 8, 6, 7, 'Glass'),
        ('band', 9, 9, 7, 9, 'Glass'),
        ('front', 0, 0, 3, 4, 'Trim_Black', 1),
        ('front', 0, 0, 4, 4, 'Light_Head', 0),
        ('front', 0, 0, 2, 2, 'Trim_Black'),
        ('rear', 0, 0, 2, 2, 'Trim_Black'),
    ]
    r = 0.47
    wheels = {'FL': (0.9, -1.62, r), 'FR': (-0.9, -1.62, r), 'RL': (0.9, 1.66, r), 'RR': (-0.9, 1.66, r)}
    eye = (0.38, 0.40, 1.50)
    bed = temp_box((1.6, 1.52, 0.6), (0, 1.77, 1.29 - 0.3 + 0.13), 'Trim_Black')
    coll, body, shell, tree = _make_car(
        'nomad', S, R, wheels, 0.115, eye, (-0.69, 0.92), (5, 10),
        creases=((4, 0.3), (5, 0.6), (6, 0.35)),
        ring_creases=((5, 6, 9, 0.75), (6, 8, 9, 0.35), (9, 5, 9, 0.7), (10, 5, 9, 0.8), (12, 5, 9, 0.8)),
        cap_bulge=(0.025, 0.02), cap_c=0.52, extra_cutters=(bed,),
        offroad=0.34,
    )
    # 前后保险杠、护板、拖车钩
    add_box(coll, body, 'BodyBumperF', (1.92, 0.2, 0.2), (0, -2.63, 0.74), bevel=0.03)
    add_box(coll, body, 'BodySkid', (1.2, 0.36, 0.025), (0, -2.5, 0.6), rot=(0.5, 0, 0), bevel=0.006, mat='Mechanical')
    add_box(coll, body, 'BodyBumperR', (1.92, 0.18, 0.16), (0, 2.66, 0.74), bevel=0.03)
    for s in (1, -1):
        add_tube(coll, body, 'BodyTowHook', [(s * 0.42, -2.72, 0.7), (s * 0.42, -2.79, 0.7), (s * 0.42, -2.79, 0.76), (s * 0.42, -2.72, 0.76)], 0.014, 'Caliper')
    # 防撞杠：一圈竖起来的钢管
    add_tube(coll, body, 'BodyBullBar', [(-0.62, -2.74, 0.72), (-0.62, -2.78, 1.12), (-0.5, -2.79, 1.2), (0.5, -2.79, 1.2), (0.62, -2.78, 1.12), (0.62, -2.74, 0.72)], 0.03)
    add_tube(coll, body, 'BodyBullBarMid', [(-0.62, -2.77, 0.98), (0.62, -2.77, 0.98)], 0.024)
    # 车顶射灯
    add_box(coll, body, 'BodyLightBar', (1.3, 0.1, 0.085), (0, -0.1, 1.935), bevel=0.012)
    for x in (-0.48, -0.16, 0.16, 0.48):
        add_box(coll, body, 'BodyLightPod', (0.26, 0.012, 0.06), (x, -0.153, 1.935), bevel=0.0, mat='Light_Head')
    # 货斗里的防滚架
    add_tube(coll, body, 'BodyRollBar', [(-0.76, 1.12, 1.27), (-0.74, 1.12, 1.8), (-0.62, 1.12, 1.9), (0.62, 1.12, 1.9), (0.74, 1.12, 1.8), (0.76, 1.12, 1.27)], 0.034)
    for s, tag in ((1, 'L'), (-1, 'R')):
        add_tube(coll, body, 'BodyRollBrace', [(s * 0.72, 1.14, 1.82), (s * 0.74, 2.2, 1.27)], 0.028)
        # 轮眉和侧踏板
        add_tube(coll, body, 'BodyArchF', arc_points(s * 1.075, -1.62, r, r + 0.135, 8, 172), 0.04)
        add_tube(coll, body, 'BodyArchR', arc_points(s * 1.075, 1.66, r, r + 0.135, 8, 172), 0.04)
        add_tube(coll, body, 'BodyStep', [(s * 1.04, -0.85, 0.5), (s * 1.06, -0.75, 0.47), (s * 1.06, 0.85, 0.47), (s * 1.04, 0.95, 0.5)], 0.035)
        # 货斗沿口的黑色护条
        add_box(coll, body, 'BodyBedRail', (0.1, 1.5, 0.022), (s * 0.9, 1.77, 1.3), bevel=0.006)
        # 挡泥板
        for y in (-1.62 + r + 0.16, 1.66 + r + 0.16):
            add_box(coll, body, 'BodyMudFlap', (0.34, 0.02, 0.3), (s * 0.9, y, 0.5), rot=(0.1, 0, 0), bevel=0.005)
        # 驾驶室和货斗之间的缝
        add_seam(coll, body, tree, 'BodyBedGap' + tag, [(1.0, 1.235), (1.0, 0.62)], 'x', s, width=0.014)
    add_box(coll, body, 'BodyBedRailRear', (1.7, 0.1, 0.022), (0, 2.5, 1.3), bevel=0.006)
    # 货斗里的备胎
    spare = link_mesh(coll, 'BodySpareTire', offroad_tire_mesh('SpareTire', r, r * 0.64, 0.34), 'BodySpareTire', body)
    spare.rotation_euler = (0, math.pi / 2, 0)
    spare.location = (0, 1.95, 0.82 + 0.175)
    # 进气管（涉水喉）：从右前翼子板沿着 A 柱伸到车顶
    add_tube(coll, body, 'BodySnorkel', [(-0.99, -1.2, 1.2), (-1.03, -1.0, 1.24), (-1.02, -0.72, 1.3), (-0.86, -0.22, 1.86), (-0.86, -0.2, 1.95)], 0.04)
    add_box(coll, body, 'BodySnorkelHead', (0.1, 0.16, 0.1), (-0.86, -0.25, 1.99), bevel=0.02)
    # 天线
    add_tube(coll, body, 'BodyAntenna', [(0.9, -1.0, 1.24), (0.9, -0.94, 2.0)], 0.005, 'Hardware')
    add_exhaust(coll, body, [-0.62], 2.7, 0.64, 0.055)
    add_mirrors(coll, body, 0.97, -0.5, 1.4)
    # 车牌挂在后保险杠中间
    add_plate(coll, body, 2.757, 0.745)

    _door(coll, body, tree, -0.68, 0.58, 0.63, 1.215, (0.42, 1.09))
    _hood(coll, body, tree, 0.84, -0.77, -2.32)
    # 尾门
    add_seam(coll, body, tree, 'BodyTailgate', fillet([(0.78, 1.235), (0.78, 0.86), (-0.78, 0.86), (-0.78, 1.235)], 0.04), 'y', 1)
    add_on_surface(coll, body, tree, 'BodyTailgateHandle', box_mesh('BodyTailgateHandle', (0.2, 0.03, 0.016), 0.006, 2, 'Trim_Black'), (0.0, 1.14), 'y', 1, lift=0.006)
    add_seam(coll, body, tree, 'BodyFuelCap', circle(1.34, 1.02, 0.075), 'x', 1, width=0.007)
    add_grille_bars(coll, body, tree, 0.46, [0.86, 0.94, 1.02], 'Mechanical', 0.022)
    add_wipers(coll, body, tree, -0.67, [(0.04, 0.6), (-0.54, 0.0)], rise=0.06)
    add_cabin_bits(coll, body, eye, (-0.2, 1.85))
    _nomad_rear(coll, body, tree, r)

    add_anchor(coll, body, 'FX_Exhaust_L', (-0.62, 2.73, 0.64))
    add_anchor(coll, body, 'FX_Exhaust_R', (-0.62, 2.73, 0.64))
    add_anchor(coll, body, 'FX_Headlight_L', (0.76, -2.63, 1.06))
    add_anchor(coll, body, 'FX_Headlight_R', (-0.76, -2.63, 1.06))
    add_anchor(coll, body, 'FX_Taillight_L', (0.86, 2.69, 1.14))
    add_anchor(coll, body, 'FX_Taillight_R', (-0.86, 2.69, 1.14))
    add_anchor(coll, body, 'Cam_Hood', (0, -1.1, 1.6))
    return coll
