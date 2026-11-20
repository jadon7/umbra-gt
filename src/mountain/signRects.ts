/** 一块牌子在图集里的位置（贴图坐标 u0, v0, u1, v1；v 朝上） */
export type Rect = [number, number, number, number];

/**
 * 路牌和招牌的图集里每块牌子的位置。图集是 sceneryMaterials.ts 在画布上画的，画的时候把位置记到这里；
 * 摆牌子的代码（scenery.ts）按名字来查。单独放一个文件，是为了无头脚本能只载入摆景物的代码、不碰画布。
 */
export const SIGNS: Record<string, Rect> = {};
