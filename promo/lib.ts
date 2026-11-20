/**
 * 注入到游戏页面里的录制工具（字符串，在页面里执行）。
 *
 * - 停掉页面自己的动画循环，之后每一帧由录制脚本调用 __app.rec.frame() 推进正好 1/60 秒
 * - __P.cam(i, camera)：自己的机位。挂在追尾镜头的 update 后面执行，
 *   所以城市（雨丝、雪花、灯光池、阴影分级）拿到的就是这个机位
 * - __P.post(i, post)：在游戏算完这一帧的后期参数之后再改（固定机位要关掉径向拉丝）
 * - __P.before(i)：每帧推进之前执行（设油门方向这些）
 * - 一些小工具：赛道上某一米的位置和方向、把车以某个车速放到赛道某处、交给自动驾驶、指定电影镜头的机位
 */
export const PAGE_LIB = String.raw`
  // 地址栏没有 mode= 的是车库：不等开车模式
  const garage = !location.search.includes('mode=');
  for (let i = 0; i < 900 && !(window.__app && (garage || (window.__app.drive && window.__app.drive.active))); i++) await new Promise((r) => setTimeout(r, 100));
  if (!window.__app || (!garage && !window.__app.drive)) throw new Error('游戏没加载出来');
  // 等加载遮罩退掉
  for (let i = 0; i < 100 && !document.getElementById('loading').classList.contains('done'); i++) await new Promise((r) => setTimeout(r, 100));
  const app = window.__app;
  const d = app.drive;
  // 录像里不要操作提示（「空格 跳过」「按 V 换回普通视角」这一行小字）
  if (!document.getElementById('promo-style')) {
    const st = document.createElement('style');
    st.id = 'promo-style';
    st.textContent = '.intro-skip { display: none !important; }';
    document.head.appendChild(st);
  }
  const E = app.engine;
  const T = app.THREE;
  app.rec.manual();
  const P = (window.__P = { i: 0, cam: null, post: null, before: null, app, d, E, T });
  if (garage) {
    if (!E.__postHooked) {
      E.onUpdate(() => {
        if (P.post) P.post(P.i, E.post);
      });
      E.__postHooked = true;
    }
  }
  /** 摆镜头：位置、看向哪、竖直视野（度）、滚转（弧度） */
  P.look = (cam, pos, target, fov = 40, roll = 0) => {
    cam.position.copy(pos);
    cam.up.set(0, 1, 0);
    cam.lookAt(target);
    if (roll) cam.rotateZ(roll);
    cam.fov = fov;
    cam.near = 0.08;
    cam.updateProjectionMatrix();
  };
  P.lerp = (a, b, t) => a + (b - a) * t;
  /** 推进一帧（录制脚本每帧调一次）。dt 比 1/60 小就是慢动作 */
  P.step = async (i, dt = 1 / 60) => {
    P.i = i;
    if (P.before) P.before(i);
    await app.rec.frame(dt);
    // 网页界面上的 CSS 动画和过渡（倒数数字、提示的淡入淡出）按真实时间走，而录一帧要几百毫秒：
    // 全部暂停，改成每录一帧往前拨 dt，和游戏的时间对齐
    for (const a of document.getAnimations()) {
      if (!a.__rec) {
        a.__rec = true;
        a.pause();
        a.currentTime = 0;
      } else {
        a.currentTime = (a.currentTime || 0) + dt * 1000;
      }
    }
  };
  if (garage) return true;
  // 闪电只在镜头需要的时候手动打
  d.world.flashTimer = 1e9;
  if (!d.__chaseWrapped) {
    const orig = d.chase.update.bind(d.chase);
    d.chase.update = (...a) => {
      orig(...a);
      if (P.cam) P.cam(P.i, E.camera);
    };
    E.onUpdate(() => {
      if (P.post) P.post(P.i, E.post);
    });
    d.__chaseWrapped = true;
  }
  const S = d.world.track ? d.world.track.samples : [];
  const L = S.length ? S[S.length - 1].s + (S[1].s - S[0].s) : 1;
  /** 赛道第 s 米：位置、前进方向、左手方向 */
  P.at = (s) => {
    s = ((s % L) + L) % L;
    const step = S[1].s - S[0].s;
    const k = s / step;
    const i0 = Math.floor(k) % S.length;
    const i1 = (i0 + 1) % S.length;
    const f = k - Math.floor(k);
    const pos = S[i0].pos.clone().lerp(S[i1].pos, f);
    const dir = S[i0].dir.clone().lerp(S[i1].dir, f).setY(0).normalize();
    const left = new T.Vector3(dir.z, 0, -dir.x);
    return { pos, dir, left, yaw: Math.atan2(dir.x, dir.z) };
  };
  /** 赛道坐标 → 世界坐标：s 米处，往左偏 x 米，离地 y 米 */
  P.tp = (s, x = 0, y = 0) => {
    const a = P.at(s);
    return a.pos.clone().addScaledVector(a.left, x).setY(a.pos.y + y);
  };
  P.vlerp = (a, b, t) => new T.Vector3().lerpVectors(a, b, t);
  /** 车在车身坐标系里的一个点（x 左，y 上，z 前）换成世界坐标 */
  P.carPt = (x, y, z) => new T.Vector3(x, y, z).applyQuaternion(app.car.root.quaternion).add(app.car.root.position);
  /** 固定机位用：关掉跟车速走的径向拉丝，快门固定 */
  P.still = (post, shutter = 1 / 60) => {
    post.speed.value = 0;
    post.shutter = shutter;
    post.aberration.value = 0.16;
    post.vignette.value = 0.48;
    // 速度流光是贴在镜头上的一层，只属于追尾镜头
    d.fx.speedLines.mesh.visible = false;
  };
  /** 把车放到赛道第 s 米、往左偏 x 米，车头朝赛道方向，直接给上车速（千米/时）并挂上合适的挡 */
  P.launch = (s, kmh = 0, x = 0) => {
    const v = d.vehicle;
    const a = P.at(s);
    const p = a.pos.clone().addScaledVector(a.left, x);
    v.reset(p.x, p.y + 0.06, p.z, a.yaw);
    const none = { throttle: 0, brake: 1, steer: 0, handbrake: false, nitro: false };
    for (let i = 0; i < 40; i++) {
      v.step(none, 1 / 120);
      d.physics.step();
    }
    const V = kmh / 3.6;
    v.body.setLinvel({ x: a.dir.x * V, y: 0, z: a.dir.z * V }, true);
    const c = v.cfg;
    if (V > 1) {
      for (let g = c.gears.length; g >= 1; g--) {
        const rpm = (V / c.wheelRadius) * 9.5493 * c.gears[g - 1] * c.finalDrive;
        v.gear = g;
        if (rpm > c.shiftDownRpm + 400) break;
      }
    }
    d.afterTeleport();
    d.fx.reset();
    d.spray.clear();
    if (d.autopilot) d.autopilot.reset(p.x, p.z);
    d.vehicle.nitro = 1;
    d.paused = false;
  };
  P.yaw = () => {
    const f = new T.Vector3(0, 0, 1).applyQuaternion(d.currQuat);
    return Math.atan2(f.x, f.z);
  };
  /**
   * 表演式自动驾驶（ShowPilot）这一帧给的输入。它是有状态的：一帧只能问一次，
   * 想在它的基础上改一点（比如不开氮气）就在 before 里每帧调一次、改完塞给 scriptedInput
   */
  P.auto = (dt = 1 / 60) => d.autopilot.update(d.vehicle, d.currPos.x, d.currPos.z, P.yaw(), dt);
  /** 交给游戏自己的自动驾驶（漂移、氮气都是它自己决定的）。cine = true 时用游戏的电影镜头 */
  P.pilot = (cine = false) => {
    d.scriptedInput = null;
    d.setAutopilot(true);
    if (!cine) d.setCine(false);
  };
  /**
   * 电影镜头只用指定的机位：P.cineKinds = ['trackside', 'heli']，换镜头时按顺序轮着用（摆不了就交给它自己挑）。
   * 机位的名字见 src/drive/CineCamera.ts 的 Kind
   */
  P.cineKinds = null;
  if (!d.__cineWrapped) {
    const cine = d.cine;
    const orig = cine.next.bind(cine);
    let k = 0;
    cine.next = function () {
      const list = P.cineKinds;
      if (list && list.length) {
        for (let n = 0; n < list.length; n++) {
          const kind = list[(k + n) % list.length];
          const shot = this.build(kind);
          if (!shot) continue;
          k = (k + n + 1) % list.length;
          this.shot = shot;
          this.history.push(kind);
          if (this.history.length > 4) this.history.shift();
          this.shotTime = 0;
          this.fresh = true;
          this.hidden = 0;
          this.sightTimer = 0;
          this.roll = 0;
          this.cut = true;
          return;
        }
      }
      orig();
    };
    d.__cineWrapped = true;
  }
  P.cineName = () => d.cine.shotName;
  P.angleDiff = (a, b) => {
    let x = (a - b) % (Math.PI * 2);
    if (x > Math.PI) x -= Math.PI * 2;
    if (x < -Math.PI) x += Math.PI * 2;
    return x;
  };
  /** 车离赛道第 s 米还有多远（沿赛道方向投影） */
  P.toS = (s) => {
    const a = P.at(s);
    return (a.pos.x - d.currPos.x) * a.dir.x + (a.pos.z - d.currPos.z) * a.dir.z;
  };
  /** 车现在在赛道第几米（在 s0..s1 这一段里找最近的采样点） */
  P.where = (s0 = 0, s1 = L) => {
    let best = 1e9, at = 0;
    for (let s = s0; s <= s1; s += 1) {
      const a = P.at(s);
      const dd = (d.currPos.x - a.pos.x) ** 2 + (d.currPos.z - a.pos.z) ** 2;
      if (dd < best) { best = dd; at = s; }
    }
    return at;
  };
  /** 车离赛道中心线多远（米，左正右负），只在 s0..s1 这一段里找最近的点 */
  P.offset = (s0, s1) => {
    let best = 1e9, off = 0;
    for (let s = s0; s <= s1; s += 1) {
      const a = P.at(s);
      const dx = d.currPos.x - a.pos.x, dz = d.currPos.z - a.pos.z;
      const dd = dx * dx + dz * dz;
      if (dd < best) { best = dd; off = dx * a.left.x + dz * a.left.z; }
    }
    return off;
  };
  /** 不出画面地快进若干帧（逻辑照常走，比渲染快得多） */
  P.skip = (n) => {
    for (let k = 0; k < n; k++) {
      if (P.before) P.before(P.i);
      d.update(1 / 60);
    }
  };
  /** 不出画面地快进，直到 cond() 为真（最多 max 帧），返回快进了多少帧 */
  P.skipUntil = (cond, max = 60 * 120) => {
    let k = 0;
    for (; k < max && !cond(); k++) {
      if (P.before) P.before(P.i);
      d.update(1 / 60);
    }
    return k;
  };
  return true;
`;
