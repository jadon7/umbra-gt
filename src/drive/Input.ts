import type { DriveInput } from './Vehicle.ts';
import type { TouchPad } from '../ui/touch.ts';

export interface ControlState extends DriveInput {
  /** 按住回头看 */
  lookBack: boolean;
}

export type ControlAction = 'reset' | 'camera' | 'exit' | 'pause' | 'help' | 'telemetry' | 'autopilot' | 'time' | 'weather';

const DEADZONE = 0.12;

/**
 * 键盘 + 手柄 + 触屏输入。
 * 键盘：W/↑ 油门，S/↓ 刹车（停稳后继续按住为倒车），A D / ← → 转向，空格 手刹，Shift 氮气
 * 手柄（标准布局）：RT 油门，LT 刹车，左摇杆转向，A 氮气，X 手刹，B 回头看，Y 切镜头，Start 暂停，Back 复位
 */
export class Input {
  enabled = false;
  /** 当前有没有手柄在用（界面据此切换按键提示） */
  gamepadActive = false;
  /** 触屏上的按钮（只有触屏设备有） */
  touch: TouchPad | null = null;

  private readonly keys = new Set<string>();
  private readonly handlers = new Map<ControlAction, () => void>();
  private readonly prevButtons: boolean[] = [];

  constructor() {
    window.addEventListener('keydown', (e) => {
      if (!this.enabled) return;
      if (e.repeat) {
        if (this.isGameKey(e.code)) e.preventDefault();
        return;
      }
      this.keys.add(e.code);
      if (this.isGameKey(e.code)) e.preventDefault();
      switch (e.code) {
        case 'KeyR':
          this.fire('reset');
          break;
        case 'KeyV':
          this.fire('camera');
          break;
        case 'Escape':
          this.fire('pause');
          break;
        case 'KeyG':
          this.fire('exit');
          break;
        case 'KeyH':
          this.fire('help');
          break;
        case 'KeyT':
          this.fire('telemetry');
          break;
        case 'KeyP':
          this.fire('autopilot');
          break;
        case 'KeyL':
          this.fire('time');
          break;
        case 'KeyK':
          this.fire('weather');
          break;
      }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  private isGameKey(code: string): boolean {
    return code.startsWith('Arrow') || code === 'Space' || code.startsWith('Shift');
  }

  on(action: ControlAction, fn: () => void): void {
    this.handlers.set(action, fn);
  }

  private fire(action: ControlAction): void {
    this.handlers.get(action)?.();
  }

  /** 从外面触发一个动作（触屏上的小按钮、暂停菜单里的选项） */
  trigger(action: ControlAction): void {
    if (this.enabled) this.fire(action);
  }

  private down(...codes: string[]): boolean {
    for (const c of codes) if (this.keys.has(c)) return true;
    return false;
  }

  read(): ControlState {
    const s: ControlState = { throttle: 0, brake: 0, steer: 0, handbrake: false, nitro: false, lookBack: false };
    if (!this.enabled) return s;

    if (this.down('KeyW', 'ArrowUp')) s.throttle = 1;
    if (this.down('KeyS', 'ArrowDown')) s.brake = 1;
    if (this.down('KeyA', 'ArrowLeft')) s.steer += 1;
    if (this.down('KeyD', 'ArrowRight')) s.steer -= 1;
    s.handbrake = this.down('Space');
    s.nitro = this.down('ShiftLeft', 'ShiftRight', 'KeyN');
    s.lookBack = this.down('KeyC');

    // 触屏：方向是左右两个键；自动油门的话车自己往前走，按着刹车的时候不给油
    const t = this.touch;
    if (t) {
      if (t.state.left) s.steer += 1;
      if (t.state.right) s.steer -= 1;
      if (t.state.brake) s.brake = 1;
      if (t.state.drift) s.handbrake = true;
      if (t.state.nitro) s.nitro = true;
      if (t.auto ? t.armed && !t.state.brake : t.state.gas) s.throttle = 1;
    }

    const pad = this.firstGamepad();
    if (pad) {
      const btn = (i: number) => pad.buttons[i]?.value ?? 0;
      const pressed = (i: number) => pad.buttons[i]?.pressed ?? false;
      let x = pad.axes[0] ?? 0;
      x = Math.abs(x) < DEADZONE ? 0 : (x - Math.sign(x) * DEADZONE) / (1 - DEADZONE);
      // 摇杆做一点曲线：中间更细腻，打满不变
      const curved = Math.sign(x) * Math.pow(Math.abs(x), 1.5);
      const any = Math.abs(x) > 0 || btn(7) > 0.05 || btn(6) > 0.05 || pressed(0) || pressed(2);
      if (any) this.gamepadActive = true;
      else if (s.throttle || s.brake || s.steer) this.gamepadActive = false;

      s.throttle = Math.max(s.throttle, btn(7));
      s.brake = Math.max(s.brake, btn(6));
      if (s.steer === 0) s.steer = -curved; // 摇杆向右为正，转向以向左为正
      s.nitro = s.nitro || pressed(0);
      s.handbrake = s.handbrake || pressed(2);
      s.lookBack = s.lookBack || pressed(1);

      // 单次触发的按键
      const edge = (i: number, action: ControlAction) => {
        const now = pressed(i);
        if (now && !this.prevButtons[i]) this.fire(action);
        this.prevButtons[i] = now;
      };
      edge(3, 'camera');
      edge(8, 'reset');
      edge(9, 'pause');
    }
    return s;
  }

  private firstGamepad(): Gamepad | null {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) if (p && p.connected && p.mapping === 'standard') return p;
    for (const p of pads) if (p && p.connected) return p;
    return null;
  }

  /** 手柄震动（碰撞、落地、氮气） */
  rumble(strong: number, weak: number, ms: number): void {
    const pad = this.firstGamepad();
    const act = pad?.vibrationActuator;
    if (!act || !this.gamepadActive) return;
    act.playEffect('dual-rumble', { duration: ms, strongMagnitude: Math.min(1, strong), weakMagnitude: Math.min(1, weak) }).catch(() => {});
  }
}
