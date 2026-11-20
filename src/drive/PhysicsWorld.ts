import RAPIER from '@dimforge/rapier3d-compat';

/** 物理固定步长：120 Hz，轮胎模型在这个频率下数值稳定 */
export const PHYSICS_DT = 1 / 120;

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export interface QuatLike {
  x: number;
  y: number;
  z: number;
  w: number;
}

const IDENTITY: QuatLike = { x: 0, y: 0, z: 0, w: 1 };

/** Rapier 世界的薄封装：初始化、静态几何、步进 */
export class PhysicsWorld {
  readonly world: RAPIER.World;
  /** 静态碰撞体挂在哪个刚体上：默认一个；beginGroup 之后换成那一组自己的 */
  private staticBody: RAPIER.RigidBody;
  private readonly groups = new Map<string, RAPIER.RigidBody>();
  private readonly sightRay = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });

  static async create(): Promise<PhysicsWorld> {
    await RAPIER.init();
    return new PhysicsWorld();
  }

  private constructor() {
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = PHYSICS_DT;
    this.staticBody = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  }

  /**
   * 之后加进来的静态碰撞体都归到这一组（一张地图一组）。
   * 两张地图的碰撞体都在同一个物理世界里、位置还是重叠的，所以同一时间只开着一组（见 setGroupEnabled）。
   */
  beginGroup(name: string): void {
    let body = this.groups.get(name);
    if (!body) {
      body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
      this.groups.set(name, body);
    }
    this.staticBody = body;
  }

  /** 把一组静态碰撞体整个开或关：关掉以后车撞不到它、车轮的射线也打不到它 */
  setGroupEnabled(name: string, on: boolean): void {
    const body = this.groups.get(name);
    if (body && body.isEnabled() !== on) body.setEnabled(on);
  }

  /** 一整块平地，顶面在 y = 0 */
  addGround(half = 3000): RAPIER.Collider {
    const desc = RAPIER.ColliderDesc.cuboid(half, 2, half).setTranslation(0, -2, 0).setFriction(1.0);
    return this.world.createCollider(desc, this.staticBody);
  }

  /** 静态长方体（护栏、坡道、建筑） */
  addBox(center: Vec3Like, half: Vec3Like, rotation: QuatLike = IDENTITY, friction = 0.3, restitution = 0.1): RAPIER.Collider {
    const desc = RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z)
      .setTranslation(center.x, center.y, center.z)
      .setRotation(rotation)
      .setFriction(friction)
      .setRestitution(restitution);
    return this.world.createCollider(desc, this.staticBody);
  }

  /** 静态圆柱（轴线竖直） */
  addCylinder(center: Vec3Like, halfHeight: number, radius: number, friction = 1.0): RAPIER.Collider {
    const desc = RAPIER.ColliderDesc.cylinder(halfHeight, radius).setTranslation(center.x, center.y, center.z).setFriction(friction);
    return this.world.createCollider(desc, this.staticBody);
  }

  /** 静态凸多面体：传入一组点，取它们的凸包 */
  addConvex(points: Float32Array, friction = 1.0): RAPIER.Collider | null {
    const desc = RAPIER.ColliderDesc.convexHull(points);
    if (!desc) return null;
    return this.world.createCollider(desc.setFriction(friction), this.staticBody);
  }

  /** 静态三角网格（拱桥桥面这类不规则的路面） */
  addTrimesh(vertices: Float32Array, indices: Uint32Array, friction = 1.0): RAPIER.Collider {
    const desc = RAPIER.ColliderDesc.trimesh(vertices, indices).setFriction(friction);
    return this.world.createCollider(desc, this.staticBody);
  }

  /**
   * 从 a 看 b，中间有没有被地形、墙、楼挡住（只算不会动的东西，车不算）。
   * 离 b 不到 slack 米才碰到的不算挡：b 通常是一辆车，它脚下的路面、身边的护栏不该算
   */
  blocked(a: Vec3Like, b: Vec3Like, slack = 3): boolean {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dy, dz);
    if (len <= slack) return false;
    const ray = this.sightRay;
    ray.origin.x = a.x;
    ray.origin.y = a.y;
    ray.origin.z = a.z;
    ray.dir.x = dx / len;
    ray.dir.y = dy / len;
    ray.dir.z = dz / len;
    return this.world.castRay(ray, len - slack, true, RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC) !== null;
  }

  step(): void {
    this.world.step();
  }
}

export { RAPIER };
