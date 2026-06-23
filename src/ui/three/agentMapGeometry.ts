/**
 * Agent Map 3D 共享几何数学
 *
 * 这些纯函数与 AgentMapPage.tsx 的 2D/伪 3D 几何语义保持一致（同样的 sessionId 哈希角度、
 * 同样的「会话年龄→半径」分档、同样的对数化 token 深度），但把原来压扁到屏幕 (sx, sy) 的
 * 伪 3D 还原为真正的世界坐标 (X, Y, Z)：Z 轴是 SVG 表达不出的纵深，Y 轴是真正的「高度」。
 *
 * 为避免改动 2D SVG 渲染路径（回归风险），这里独立复制一份极小的确定性纯数学，
 * 而不是去 refactor 页面里已有的同名常量。两份实现语义一致。
 */
import { Vector3 } from 'three';
import type { SessionMapItem } from '../../types';

const DAY = 86400_000;

const TOKEN_MAX = 1_000_000; // 对数缩放参考上界（仅作 tokenDepth 视觉量参考）

/**
 * 时间（会话年龄，天）→ 3D 世界径向半径：分段映射。
 * 0–1 天段放大 4 倍（让 1 天环足够明显），其余段保持原尺寸与比例。
 */
const TIME_TIERS = [0, 1, 5, 10, 30]; // 天
const TIME_BANDS = [16, 8, 16, 32];   // 各段径向长度：[0–1d, 1–5d, 5–10d, 10–30d]
const TIME_RADII: number[] = (() => {
  const arr = [0];
  let r = 0;
  for (const b of TIME_BANDS) { r += b; arr.push(r); }
  return arr; // [0, 16, 24, 40, 72]
})();

export const APEX = new Vector3(0, 0, 0); // 中心点：位于底部平面中心，节点从这里向上生长

/** 按会话年龄（天）计算 3D 世界径向半径（节点扩散与地面同心圆共用） */
export function worldRadiusForAgeDays(days: number): number {
  if (!Number.isFinite(days) || days <= 0) return 0;
  for (let i = 1; i < TIME_TIERS.length; i++) {
    if (days <= TIME_TIERS[i]) {
      const k = (days - TIME_TIERS[i - 1]) / (TIME_TIERS[i] - TIME_TIERS[i - 1]);
      return TIME_RADII[i - 1] + (TIME_RADII[i] - TIME_RADII[i - 1]) * k;
    }
  }
  return TIME_RADII[TIME_RADII.length - 1]; // 超过 30 天饱和
}

// 节点视觉半径（世界单位）：与 2D 的 SessionNodeSvg 尺寸公式保持一致——
// 2D: r = NODE_R_MIN + (NODE_R_MAX-NODE_R_MIN) * min(req/100, 1)；这里用同样的 activity 线性映射到世界半径。
export const R_MIN = 0.7;
export const R_MAX = 4.0;
export const RADIUS_BUCKETS = 10;

/** 与 2D 一致的「请求轮数 → 归一化尺寸」活动度（100 轮饱和） */
export function nodeActivity(req: number): number {
  return Math.min((req || 0) / 100, 1);
}

export function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/** token 总量 → 归一化深度 0..1（对数缩放，仅作连线透明度等视觉量参考） */
export function tokenDepth(total: number): number {
  const t = Math.max(0, total | 0);
  if (t <= 0) return 0;
  return Math.max(0, Math.min(1, Math.log10(t + 1) / Math.log10(TOKEN_MAX + 1)));
}

/**
 * Token → 高度（世界单位）的阶梯式分段映射。
 * 设计：每跨过一个临界点（每档 token 约为上一档的 10×），下一段高度比前一段更长，
 * 但放大倍率封顶在 2×（按真实比例拉伸、又不会爆掉）——越往上每段越长，大 token 明显往上铺开。
 * 超过最高档（1B）后饱和，不再继续拔高。
 */
// 各段高度：0–10k 段放大 4 倍（避免底部节点堆地），其余段保持原尺寸与比例
// 各段高度：0–10k 与 10k–100k 等高（9），自 100k 起按 ×2 递增（18→36→72→144）
const HEIGHT_BANDS = [9, 9, 18, 36, 72, 144]; // [0–10k, 10k–100k, 100k–1M, 1M–10M, 10M–100M, 100M–1B]
const TIER_TOKENS = [0, 10_000, 100_000, 1_000_000, 10_000_000, 100_000_000, 1_000_000_000];

/** 累加各段高度得到 [token, height] 控制点（供插值与量尺定位） */
function buildHeightPoints(): [number, number][] {
  const pts: [number, number][] = [[TIER_TOKENS[0], 0]];
  let h = 0;
  for (let i = 0; i < HEIGHT_BANDS.length; i++) {
    h += HEIGHT_BANDS[i];
    pts.push([TIER_TOKENS[i + 1], h]);
  }
  return pts;
}

export const H_POINTS: [number, number][] = buildHeightPoints();

/** 量尺上要标注的临界点（含底部 10k 一档） */
export const AXIS_TICKS: ReadonlyArray<[number, number]> = [
  [10_000, tokenHeightOf(10_000)],
  [100_000, tokenHeightOf(100_000)],
  [1_000_000, tokenHeightOf(1_000_000)],
  [10_000_000, tokenHeightOf(10_000_000)],
  [100_000_000, tokenHeightOf(100_000_000)],
  [1_000_000_000, tokenHeightOf(1_000_000_000)],
];

function tokenHeightOf(total: number): number {
  const t = Math.max(0, total | 0);
  if (t <= 0) return 0;
  for (let i = 1; i < H_POINTS.length; i++) {
    if (t <= H_POINTS[i][0]) {
      const [a0, h0] = H_POINTS[i - 1];
      const [a1, h1] = H_POINTS[i];
      const k = (t - a0) / (a1 - a0);
      return h0 + (h1 - h0) * k;
    }
  }
  // 超过最高档：趋近饱和上界（不再无限拔高）
  return H_POINTS[H_POINTS.length - 1][1];
}

export function tokenHeight(total: number): number {
  return tokenHeightOf(total);
}

/** Token 数值 → 简短文本（100k / 1M / 10M / 100M / 1B ...） */
export function formatTokensShort(v: number): string {
  if (v >= 1_000_000_000) return `${v / 1_000_000_000}B`;
  if (v >= 1_000_000) return `${v / 1_000_000}M`;
  if (v >= 1_000) return `${v / 1_000}k`;
  return `${v}`;
}

/** 请求轮数 → 世界半径（量化档位用于共享 SphereGeometry）；activity 与 2D 一致（req/100 饱和） */
export function radiusBucketFromRequests(req: number): { radius: number; bucket: number } {
  const k = nodeActivity(req);
  const bucket = Math.max(0, Math.min(RADIUS_BUCKETS - 1, Math.round(k * (RADIUS_BUCKETS - 1))));
  const bucketRadius = R_MIN + (R_MAX - R_MIN) * (bucket / (RADIUS_BUCKETS - 1));
  return { radius: bucketRadius, bucket };
}

export interface WorldPlacement {
  pos: Vector3;            // 节点世界坐标
  radius: number;          // 视觉半径（世界单位，已量化）
  bucket: number;          // 半径档位
  depth01: number;         // token 归一化深度
  split: Vector3 | null;   // 输入/输出切分点（沿 apex→pos；无 input/output 数据为 null）
}

/**
 * 由 SessionMapItem 计算真正的 3D 世界坐标（倒置结构）。
 * - 中心点 APEX 位于底部平面正中心 (0,0,0)；底部平面与同心圆保持不变。
 * - X / Z：由 sessionId 哈希角度 + 会话年龄径向半径（分段 ≤2× 增长，见 worldRadiusForAgeDays）决定。
 * - Y：由 token 总量决定——token 越多节点越往上长（离地面越远），token=0 贴在地面 y=0。
 * - split：沿 apex→pos 按 input/(input+output) 比例取点。
 */
export function worldFromSession(s: SessionMapItem, now: number): WorldPlacement {
  const rawAge = now - s.firstRequestAt;
  const ageDays = Number.isFinite(rawAge) && rawAge > 0 ? rawAge / DAY : 0;

  const angle = ((hashStr(s.sessionId) % 360) + (hashStr(s.sessionId + '~j') % 40 - 20)) * (Math.PI / 180);
  const spread = worldRadiusForAgeDays(ageDays);
  const x = Math.cos(angle) * spread;
  const z = Math.sin(angle) * spread;

  // 高度：Token 阶梯式分段映射（压缩大值，避免顶到天上）；depth01 仅作连线透明度参考
  const depth01 = tokenDepth(s.totalTokens);
  const y = tokenHeight(s.totalTokens);
  const pos = new Vector3(x, y, z);

  // 仅当输入、输出都 >0 时才有切分点（用于两段不同色）；任一为 0 → split=null，画完整累计连线
  let split: Vector3 | null = null;
  const input = s.inputTokens | 0;
  const output = s.outputTokens | 0;
  if (input > 0 && output > 0) {
    // 输入段占比 = input/(input+output)；但输出段至少占 3/20，避免输入远大于输出时输出段不可见
    const MIN_OUTPUT_FRAC = 3 / 20;
    const ratio = Math.min(input / (input + output), 1 - MIN_OUTPUT_FRAC);
    split = new Vector3(
      APEX.x + (pos.x - APEX.x) * ratio,
      APEX.y + (pos.y - APEX.y) * ratio,
      APEX.z + (pos.z - APEX.z) * ratio,
    );
  }

  const { radius, bucket } = radiusBucketFromRequests(s.requestCount);
  return { pos, radius, bucket, depth01, split };
}
