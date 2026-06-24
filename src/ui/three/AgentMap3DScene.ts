/**
 * Agent Map 3D 场景（Three.js / WebGL）
 *
 * 仅在任务雷达「3D 视图」下挂载。把每个 Session 画成真正的 3D 星球节点：
 * - X/Z：sessionId 哈希角度 + 会话年龄半径（真正的纵深轴，SVG 表达不出）
 * - Y：token 总量驱动的高度（token 越多越靠近顶点，token=0 沉到地面）
 * - 顶点→节点连线分输入/输出两段（与 SVG 版语义一致）
 *
 * 视觉与 2D 保持一致：颜色按状态取主题强调色、尺寸用与 2D 相同的线性公式、
 * active/error 节点带加法混合的脉冲发光圈（对应 2D 的 .am-node-glow），completed 为虚线半透明。
 * 透明背景：canvas 透出页面渐变背景（--bg-primary 是 linear-gradient，必须真透明才能匹配），
 * 因此不使用会合成成不透明黑底的后处理（Bloom）；自发光感由 emissive 材质 + 加法光晕提供。
 * PBR 光照 + 雾化纵深 + Line2 粗线 + 阻尼轨道相机 + 按帧 lerp 平滑过渡 SSE 更新。
 * React 仅通过本类的命令式 API 驱动，绝不每帧重建场景图。
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';

import type { SessionMapItem, SessionStatus } from '../../types';
import {
  APEX,
  R_MIN,
  R_MAX,
  RADIUS_BUCKETS,
  AXIS_TICKS,
  formatTokensShort,
  worldRadiusForAgeDays,
  worldFromSession,
} from './agentMapGeometry';
// 客户端 logo（SVG，运行时光栅化为纹理贴在球面朝向相机一侧）
import claudeLogoRaw from '../assets/claudecode-color.svg?raw';
import codexLogoRaw from '../assets/codex-color.svg?raw';
import opencodeLogoRaw from '../assets/opencode-color.svg?raw';

export interface AgentMap3DSceneCallbacks {
  onSelect: (sessionId: string | null) => void;
  /** WebGL 上下文丢失 / 不可用 —— 页面回退到 SVG */
  onContextLost?: () => void;
}

interface NodeHandle {
  sessionId: string;
  group: THREE.Group;
  sphere: THREE.Mesh;
  sphereMat: THREE.MeshStandardMaterial;
  glow: THREE.Mesh;          // 脉冲发光圈（对应 2D .am-node-glow），仅 active/error 可见
  glowMat: THREE.MeshBasicMaterial;
  decal: THREE.Mesh;         // logo 贴片（贴在上半球偏前的小平面，不随球面 UV 变形）
  decalMat: THREE.MeshBasicMaterial;
  labelEl: HTMLDivElement;
  label: CSS2DObject;
  targetPos: THREE.Vector3;
  status: SessionStatus;
  radius: number;
  bucket: number;
  depth01: number;
  inFlight: number;
  split: THREE.Vector3 | null;
}

interface LinkHandle {
  group: THREE.Group;
  bg: Line2;          // 完整累计连线（输入/输出任一缺失时显示）
  bgMat: LineMaterial;
  segIn: Line2;       // 输入段：顶点→split（输入色）
  segInMat: LineMaterial;
  segOut: Line2;      // 输出段：split→节点（输出色）
  segOutMat: LineMaterial;
}

// 相机：拉近、瞄准偏下的中心区，让中心点与底层节点在初始/复位视图里更显眼
// （整体比例放大；顶部超高节点可经轨道上仰/缩出查看）
const CAM_HOME = new THREE.Vector3(0, 60, 60);
const CAM_TARGET = new THREE.Vector3(0, 28, 0);
// logo 贴片在球面上的固定位置：上半球偏前（朝相机方向），法线朝外
const DECAL_DIR = new THREE.Vector3(0, 0.82, 0.58).normalize();
const DECAL_HALF_ANG = 0.32; // 贴片半张角（弧度），决定贴片覆盖的球面范围（小贴片）
// 连线输出段固定亮蓝色（高亮）；输入段、累计段用主题色（palette.active）
const LINK_OUTPUT_COLOR = 0x00d600; // 输出段：亮蓝

/** 构造与球面同弧度的曲面贴片几何：以 PlaneGeometry 网格为基础，把顶点投到半径 r 的球面上（围绕 DECAL_DIR）。
 *  UV 沿用平面 0..1，logo 不变形；顶点落在球面上 → 弧度与球面完全一致。按半径桶缓存共享。 */
function buildCurvedDecalGeometry(radius: number): THREE.BufferGeometry {
  const seg = 12;
  const geo = new THREE.PlaneGeometry(1, 1, seg, seg);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  // DECAL_DIR 的切空间正交基
  const up = Math.abs(DECAL_DIR.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
  const t1 = new THREE.Vector3().crossVectors(DECAL_DIR, up).normalize();
  const t2 = new THREE.Vector3().crossVectors(DECAL_DIR, t1).normalize();
  const q1 = new THREE.Quaternion();
  const q2 = new THREE.Quaternion();
  const dir = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    const ax = pos.getX(i) * 2 * DECAL_HALF_ANG; // -halfAng..halfAng
    const ay = pos.getY(i) * 2 * DECAL_HALF_ANG;
    q1.setFromAxisAngle(t1, ax);
    q2.setFromAxisAngle(t2, ay);
    dir.copy(DECAL_DIR).applyQuaternion(q1).applyQuaternion(q2).normalize();
    const r = radius * 1.003; // 略浮于球面避免 z-fight
    pos.setXYZ(i, dir.x * r, dir.y * r, dir.z * r);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

const STATUS_VAR: Record<SessionStatus, string> = {
  active: '--accent-primary',
  idle: '--accent-warning',
  completed: '--border-secondary',
  error: '--accent-danger',
};

export class AgentMap3DScene {
  private container: HTMLElement;
  private cb: AgentMap3DSceneCallbacks;

  private renderer!: THREE.WebGLRenderer;
  private css2d!: CSS2DRenderer;
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private controls!: OrbitControls;
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private clock = new THREE.Clock();

  private nodes = new Map<string, NodeHandle>();
  private links = new Map<string, LinkHandle>();
  private pickables: THREE.Mesh[] = [];

  private sphereGeoms: THREE.SphereGeometry[] = [];
  private glowGeoms: THREE.SphereGeometry[] = [];
  private decalGeoms: THREE.BufferGeometry[] = []; // logo 曲面贴片几何（按半径桶共享）
  // 选中节点的「土星环」指示：绕选中球体的同色倾斜环，持续旋转
  private ringPivot!: THREE.Object3D;
  private ringMesh!: THREE.Mesh;
  private ringMat!: THREE.MeshBasicMaterial;
  private floor!: THREE.Mesh;
  private floorRings: { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial }[] = [];
  private apexMat!: THREE.MeshBasicMaterial;
  private apexMesh!: THREE.Mesh;
  // Token 量尺：纵轴 + 刻度标签
  private axisMat!: LineMaterial;
  private axisLine!: Line2;
  private axisLabels: CSS2DObject[] = [];
  // 地面同心圆天数标签
  private ringLabels: CSS2DObject[] = [];

  private palette!: Record<SessionStatus, THREE.Color>;
  private completedNodeColor!: THREE.Color; // 已完成节点：浅绿（区别于中性 palette.completed）
  private bgColor!: THREE.Color;
  private logoTexCache = new Map<string, THREE.CanvasTexture>(); // logo 纹理：按 agent×status 烘焙缓存
  private logoImg: Record<string, HTMLImageElement> = {};        // agent → 已加载的 SVG <Image>

  private selectedId: string | null = null;
  private showAllLabels = false;
  private showLinks = false;
  private focusTarget: { cam: THREE.Vector3; look: THREE.Vector3 } | null = null;
  private rafId = 0;
  private running = false;
  private disposed = false;

  private downClient = { x: 0, y: 0 };
  private downCamPos = new THREE.Vector3();
  private downCamQuat = new THREE.Quaternion();
  private pointerDownTime = 0;

  private ro?: ResizeObserver;
  private mo?: MutationObserver;
  private probeEl: HTMLDivElement;

  constructor(container: HTMLElement, cb: AgentMap3DSceneCallbacks) {
    this.container = container;
    this.cb = cb;
    this.probeEl = document.createElement('div');
    this.probeEl.style.position = 'absolute';
    this.probeEl.style.visibility = 'hidden';
    this.probeEl.style.pointerEvents = 'none';
    try {
      this.build();
    } catch (e) {
      this.dispose();
      throw e;
    }
  }

  // ============================ 构建 ============================

  private build(): void {
    const w = this.container.clientWidth || 800;
    const h = this.container.clientHeight || 600;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    this.renderer.setClearColor(0x000000, 0); // 透明背景，透出页面 .am-canvas-wrap 背景
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.style.position = 'absolute';
    this.renderer.domElement.style.inset = '0';
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.cursor = 'grab';
    this.container.appendChild(this.renderer.domElement);
    this.renderer.domElement.addEventListener('webglcontextlost', this.onContextLost, false);

    this.css2d = new CSS2DRenderer();
    this.css2d.setSize(w, h);
    const css2dDom = this.css2d.domElement;
    css2dDom.style.position = 'absolute';
    css2dDom.style.inset = '0';
    css2dDom.style.width = '100%';
    css2dDom.style.height = '100%';
    css2dDom.style.pointerEvents = 'none';
    this.container.appendChild(css2dDom);

    this.scene = new THREE.Scene();
    this.refreshPalette();
    // 透明背景：不设 scene.background，画布透出页面背景；雾化淡入到页面背景色，远处节点自然融入
    this.scene.background = null;
    this.scene.fog = new THREE.Fog(this.bgColor.getHex(), 250, 3000);

    this.camera = new THREE.PerspectiveCamera(50, w / h, 0.1, 30000);
    this.camera.position.copy(CAM_HOME);
    this.camera.lookAt(CAM_TARGET);

    const ambient = new THREE.AmbientLight(0xffffff, 0.85);
    this.scene.add(ambient);
    const dir = new THREE.DirectionalLight(0xffffff, 1.0);
    dir.position.set(150, 500, 200);
    this.scene.add(dir);
    const point = new THREE.PointLight(0xffd9a0, 0.6, 2000, 1.2);
    point.position.set(0, 150, 0);
    this.scene.add(point);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.copy(CAM_TARGET);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.rotateSpeed = 0.7;
    this.controls.zoomSpeed = 0.9;
    this.controls.panSpeed = 0.8;
    this.controls.minDistance = 6;
    this.controls.maxDistance = 6000;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    // 用户一旦开始操作（旋转/缩放/平移），立即取消自动聚焦/复位过渡，把相机完全交给用户
    this.controls.addEventListener('start', () => {
      this.focusTarget = null;
      this.renderer.domElement.style.cursor = 'grabbing';
    });
    this.controls.addEventListener('end', () => { this.renderer.domElement.style.cursor = 'grab'; });

    // 共享 geometry：按半径档位（球体 + 发光圈 + logo 曲面贴片各一组）
    for (let i = 0; i < RADIUS_BUCKETS; i++) {
      const r = this.bucketRadius(i);
      this.sphereGeoms.push(new THREE.SphereGeometry(r, 32, 24));
      this.glowGeoms.push(new THREE.SphereGeometry(r * 1.55, 24, 16));
      this.decalGeoms.push(buildCurvedDecalGeometry(r));
    }

    // 地面（深度参照）：圆盘覆盖到最外圈（365 天）之外
    const floorR = worldRadiusForAgeDays(365) + 14;
    this.floor = new THREE.Mesh(
      new THREE.CircleGeometry(floorR, 96),
      new THREE.MeshBasicMaterial({ color: this.palette.completed, transparent: true, opacity: 0.05, side: THREE.DoubleSide }),
    );
    this.floor.rotation.x = -Math.PI / 2;
    this.scene.add(this.floor);
    // 同心圆对齐到 1 / 7 / 30 / 365 天的时间阶梯临界
    const ringDays = [1, 7, 30, 365];
    for (const days of ringDays) {
      const r = worldRadiusForAgeDays(days);
      const mat = new THREE.MeshBasicMaterial({ color: this.palette.completed, transparent: true, opacity: 0.2, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(new THREE.RingGeometry(r - 1, r + 1, 128), mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = 0.01;
      this.scene.add(mesh);
      this.floorRings.push({ mesh, mat });
      // 天数标签（贴在圆环上，billboard 始终可读；365 天显示为「1年」）
      const labelEl = document.createElement('div');
      labelEl.className = 'am-axis-label';
      labelEl.style.pointerEvents = 'none';
      labelEl.textContent = days >= 365 ? '1年' : `${days} 天`;
      const labelObj = new CSS2DObject(labelEl);
      labelObj.position.set(r, 0.6, 0);
      this.scene.add(labelObj);
      this.ringLabels.push(labelObj);
    }

    // 中心点：底面上的一个小圆（非球），与时间线同心圆同色
    this.apexMat = new THREE.MeshBasicMaterial({ color: this.palette.completed, side: THREE.DoubleSide });
    this.apexMesh = new THREE.Mesh(new THREE.CircleGeometry(0.7, 32), this.apexMat);
    this.apexMesh.rotation.x = -Math.PI / 2; // 平贴地面
    this.apexMesh.position.set(0, 0.02, 0);  // 略高于地面避免 z-fight
    this.scene.add(this.apexMesh);

    // 选中外描边（单例）
    // 选中节点的土星环：pivot 绕世界 Y 旋转，环在 pivot 内倾斜（土星感）
    this.ringMat = new THREE.MeshBasicMaterial({ color: this.palette.active.clone(), transparent: true, opacity: 0.85, side: THREE.DoubleSide });
    this.ringMesh = new THREE.Mesh(new THREE.TorusGeometry(1, 0.05, 12, 80), this.ringMat);
    this.ringMesh.rotation.x = Math.PI * 0.42; // 倾斜
    this.ringPivot = new THREE.Object3D();
    this.ringPivot.add(this.ringMesh);
    this.ringPivot.visible = false;
    this.scene.add(this.ringPivot);

    // Token 量尺：中心点垂直向上的纵轴 + 100k 刻度标签（100k..1000k，1 单位 = 100k token）
    this.buildAxis(w, h);

    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', this.onPointerDown);
    el.addEventListener('pointerup', this.onPointerUp);

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.container);
    this.mo = new MutationObserver(() => this.refreshTheme());
    this.mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    document.addEventListener('visibilitychange', this.onVisibility);

    this.running = true;
    this.clock.start();
    this.loop();
  }

  private bucketRadius(bucket: number): number {
    return R_MIN + (R_MAX - R_MIN) * (bucket / (RADIUS_BUCKETS - 1));
  }

  /** 取 logo「贴片」纹理：透明底纯 logo（按 agent 缓存），贴在小平面 decal 上，不随球面 UV 变形 */
  private getDecalTex(agent: string): THREE.CanvasTexture {
    const cached = this.logoTexCache.get(agent);
    if (cached) return cached;
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.anisotropy = 8;
    this.logoTexCache.set(agent, tex);
    const FRAC = 0.8; // logo 占贴纸大部分
    const ls = Math.round(size * FRAC);
    const off = (size - ls) / 2;
    this.ensureLogoImg(agent).then(img => {
      ctx.drawImage(img, off, off, ls, ls);
      tex.needsUpdate = true;
    });
    return tex;
  }

  /** 按状态调节 logo 贴片的显眼度：已完成（网状）明显降低明度与透明度，使其不凸显 */
  private applyDecalTint(m: THREE.MeshBasicMaterial, status: SessionStatus): void {
    if (status === 'completed') { m.opacity = 0.32; m.color.set(0x9aa0a6); }
    else if (status === 'idle') { m.opacity = 0.8; m.color.set(0xffffff); }
    else { m.opacity = 1; m.color.set(0xffffff); }
  }

  /** 按状态 + 选中态刷新节点外观（仅改外观，不动 depthTest/renderOrder —— 选中节点保持原始层级，正常被深度遮挡）：
   *  - 选中：实心 + 不透明（opacity 1，含已完成）。active 还显示脉冲描边光环；非 active 无呼吸。
   *  - 未选中：按状态恢复（completed 半透明线框等）。 */
  private applyNodeAppearance(h: NodeHandle): void {
    const isSelected = h.sessionId === this.selectedId;
    const isCompleted = h.status === 'completed';
    if (isSelected) {
      h.sphereMat.wireframe = false;
      h.sphereMat.transparent = false;             // 选中一律不透明
      h.sphereMat.opacity = 1;
      h.decalMat.opacity = 1;
      h.decalMat.color.set(0xffffff);
    } else {
      h.sphereMat.transparent = isCompleted;
      h.sphereMat.opacity = isCompleted ? 0.7 : 1;
      h.sphereMat.wireframe = isCompleted;
      this.applyDecalTint(h.decalMat, h.status);
    }
  }

  private ensureLogoImg(agent: string): Promise<HTMLImageElement> {
    const existing = this.logoImg[agent];
    if (existing && existing.complete) return Promise.resolve(existing);
    const raw = agent === 'codex' ? codexLogoRaw : agent === 'opencode' ? opencodeLogoRaw : claudeLogoRaw;
    // 以高分辨率（512）光栅化 SVG，再缩小绘制，保证小尺寸下无锯齿
    const sized = raw.replace(/width="[^"]*"/, 'width="512"').replace(/height="[^"]*"/, 'height="512"');
    const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(sized);
    const img = existing || new Image();
    img.crossOrigin = 'anonymous';
    const p = new Promise<HTMLImageElement>(res => {
      img.onload = () => { this.logoImg[agent] = img; res(img); };
      img.onerror = () => res(img);
    });
    img.src = url;
    return p;
  }

  /** Token 量尺：中心点垂直纵轴 + 仅临界点刻度（100k/1M/10M/100M/1B），按阶梯高度放置 */
  private buildAxis(w: number, h: number): void {
    const TOP = AXIS_TICKS[AXIS_TICKS.length - 1][1] + 6; // 轴顶略高于最高临界点
    this.axisMat = new LineMaterial({
      color: this.palette.completed.getHex(),
      linewidth: 2,
      transparent: true,
      opacity: 0.5,
      dashed: true,
      dashScale: 1,
      dashSize: 0.4,
      gapSize: 0.25,
    });
    this.axisMat.resolution = new THREE.Vector2(w, h);
    const geo = new LineGeometry();
    geo.setPositions([0, 0, 0, 0, TOP, 0]);
    this.axisLine = new Line2(geo, this.axisMat);
    this.axisLine.computeLineDistances();
    this.scene.add(this.axisLine);

    // 仅标注阶梯临界点
    for (const [token, height] of AXIS_TICKS) {
      const el = document.createElement('div');
      el.className = 'am-axis-label';
      el.style.pointerEvents = 'none';
      el.textContent = formatTokensShort(token);
      const obj = new CSS2DObject(el);
      obj.position.set(0.6, height, 0);
      this.scene.add(obj);
      this.axisLabels.push(obj);
    }
  }

  // ============================ 调色板（主题） ============================

  private refreshPalette(): void {
    this.palette = {
      active: this.resolveColor(STATUS_VAR.active),
      idle: this.resolveColor(STATUS_VAR.idle),
      completed: this.resolveColor(STATUS_VAR.completed),
      error: this.resolveColor(STATUS_VAR.error),
    };
    // 雾化淡入到页面背景的代表色（--bg-primary 是渐变，取其 solid 代表色）
    this.bgColor = this.resolveColor('--bg-primary-solid');
    // 已完成节点：浅绿（按主题取色，保证在浅/深背景上都可读）
    this.completedNodeColor = new THREE.Color(
      document.documentElement.getAttribute('data-theme') === 'dark' ? '#4ADE80' : '#86EFAC',
    );
  }

  private resolveColor(varName: string): THREE.Color {
    if (!this.probeEl.parentElement) document.body.appendChild(this.probeEl);
    this.probeEl.style.color = `var(${varName})`;
    const str = getComputedStyle(this.probeEl).color || 'rgb(128,128,128)';
    return new THREE.Color(str);
  }

  private refreshTheme(): void {
    this.refreshPalette();
    // 背景保持透明（null）；仅雾色跟随主题
    if (this.scene.fog) (this.scene.fog as THREE.Fog).color.copy(this.bgColor);
    // 主题变了 → 重刷球体状态色与发光色（logo 贴片纹理与主题无关，无需重建）
    for (const h of this.nodes.values()) {
      const isCompleted = h.status === 'completed';
      h.sphereMat.color.copy(isCompleted ? this.completedNodeColor : this.palette[h.status]);
      h.glowMat.color.copy(this.palette[h.status]);
    }
    for (const l of this.links.values()) {
      l.bgMat.color.copy(this.palette.active);          // 累计连线（主题绿）
      l.segInMat.color.copy(this.palette.active);       // 输入段：主题绿
      l.segOutMat.color.setHex(LINK_OUTPUT_COLOR);      // 输出段：亮蓝（固定）
    }
    (this.floor.material as THREE.MeshBasicMaterial).color.copy(this.palette.completed);
    for (const r of this.floorRings) r.mat.color.copy(this.palette.completed);
    this.apexMat.color.copy(this.palette.completed); // 中心点圆与时间线同心圆同色
    // 主题变了 → 若有选中节点，土星环颜色随之刷新
    if (this.selectedId) {
      const h = this.nodes.get(this.selectedId);
      if (h) this.ringMat.color.copy(h.status === 'completed' ? this.completedNodeColor : this.palette[h.status]);
    }
    if (this.axisMat) this.axisMat.color.copy(this.palette.completed);
  }

  // ============================ 数据更新（diff） ============================

  update(sessions: SessionMapItem[], now: number): void {
    if (this.disposed) return;
    const incoming = new Set(sessions.map(s => s.sessionId));
    for (const s of sessions) {
      const p = worldFromSession(s, now);
      const exist = this.nodes.get(s.sessionId);
      if (exist) this.updateNode(exist, s, p);
      else this.createNode(s, p);
      const link = this.links.get(s.sessionId);
      if (link) this.updateLink(link, p);
      else this.createLink(s.sessionId, p);
    }
    for (const [id, h] of [...this.nodes.entries()]) {
      if (!incoming.has(id)) {
        this.disposeNode(h);
        this.nodes.delete(id);
        const l = this.links.get(id);
        if (l) { this.disposeLink(l); this.links.delete(id); }
      }
    }
    if (this.selectedId && !this.nodes.has(this.selectedId)) this.applySelection(null);
    this.refreshPickables();
  }

  private createNode(s: SessionMapItem, p: ReturnType<typeof worldFromSession>): void {
    const group = new THREE.Group();
    group.position.copy(p.pos);

    const geom = this.sphereGeoms[p.bucket];
    const isCompleted = s.status === 'completed';
    const mat = new THREE.MeshStandardMaterial({
      color: (isCompleted ? this.completedNodeColor : this.palette[s.status]).clone(),
      roughness: 0.5,
      metalness: 0.1,
      transparent: isCompleted,
      opacity: isCompleted ? 0.7 : 1,
      wireframe: isCompleted,
    });
    const sphere = new THREE.Mesh(geom, mat);
    group.add(sphere);

    // 脉冲发光圈（对应 2D .am-node-glow）：加法混合营造辉光，仅 active/error 显示
    const glowMat = new THREE.MeshBasicMaterial({
      color: this.palette[s.status].clone(),
      transparent: true,
      opacity: 0.0,
      side: THREE.BackSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const glow = new THREE.Mesh(this.glowGeoms[p.bucket], glowMat);
    glow.visible = s.status === 'active';
    group.add(glow);

    // logo 曲面贴片：与球面同弧度（顶点落在球面上），挂到 sphere 下作为子节点 → 随球体呼吸一起缩放
    const decalMat = new THREE.MeshBasicMaterial({
      map: this.getDecalTex(s.agent),
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.applyDecalTint(decalMat, s.status);
    const decal = new THREE.Mesh(this.decalGeoms[p.bucket], decalMat);
    sphere.add(decal); // 子节点：继承 sphere 的脉冲缩放，紧贴球面

    // 标签（CSS2D）：显隐由 label.visible 控制（CSS2DRenderer 每帧按 visible 覆写 display）
    // 标签可见时可点击 → 选中该节点并展开详情 popover（pointer-events 由祖先 none 覆写为 auto）
    const sid = s.sessionId;
    const labelEl = document.createElement('div');
    labelEl.className = 'am-node-label';
    // pointer-events 跟随标签开关：开→可点选；关→不拦截鼠标（仅选中节点标签可见也不挡操作）
    const labelPE = this.showAllLabels ? 'auto' : 'none';
    labelEl.style.pointerEvents = labelPE;
    labelEl.style.cursor = labelPE === 'auto' ? 'pointer' : 'default';
    labelEl.addEventListener('click', (ev) => {
      ev.stopPropagation();
      this.cb.onSelect(sid);
    });
    const titleEl = document.createElement('div');
    titleEl.className = 'am-node-label-title';
    const subEl = document.createElement('div');
    subEl.className = 'am-node-label-sub';
    labelEl.appendChild(titleEl);
    labelEl.appendChild(subEl);
    const label = new CSS2DObject(labelEl);
    label.position.set(0, -p.radius * 1.8, 0);
    group.add(label);

    this.scene.add(group);

    const handle: NodeHandle = {
      sessionId: s.sessionId,
      group, sphere, sphereMat: mat, glow, glowMat, decal, decalMat, labelEl, label,
      targetPos: p.pos.clone(),
      status: s.status, radius: p.radius, bucket: p.bucket,
      depth01: p.depth01, inFlight: s.inFlight | 0, split: p.split ? p.split.clone() : null,
    };
    this.nodes.set(s.sessionId, handle);
    this.writeLabel(handle, s);
    this.syncLabel(handle);
    this.applyNodeAppearance(handle); // 若新建节点已被选中 → 强制不透明
  }

  private updateNode(h: NodeHandle, s: SessionMapItem, p: ReturnType<typeof worldFromSession>): void {
    h.targetPos.copy(p.pos);
    h.depth01 = p.depth01;
    h.inFlight = s.inFlight | 0;
    h.split = p.split ? p.split.clone() : null;

    if (p.bucket !== h.bucket) {
      h.bucket = p.bucket;
      h.radius = p.radius;
      h.sphere.geometry = this.sphereGeoms[p.bucket];
      h.glow.geometry = this.glowGeoms[p.bucket];
      h.decal.geometry = this.decalGeoms[p.bucket]; // 贴片几何随半径桶同步
      h.label.position.set(0, -p.radius * 1.8, 0);
      if (this.selectedId === h.sessionId) this.ringMesh.scale.setScalar(p.radius * 1.8);
    }

    if (s.status !== h.status) {
      h.status = s.status;
      const isCompleted = s.status === 'completed';
      const c = isCompleted ? this.completedNodeColor : this.palette[s.status];
      h.sphereMat.color.copy(c);
      h.glowMat.color.copy(this.palette[s.status]);
      h.glow.visible = s.status === 'active';
      this.applyNodeAppearance(h); // 状态变了 → 透明度/线框/贴片按状态+选中态刷新
      // 若是当前选中节点，土星环颜色随新状态刷新
      if (h.sessionId === this.selectedId) this.showRing(h);
    }
    this.writeLabel(h, s);
    this.syncLabel(h);
  }

  private writeLabel(h: NodeHandle, s: SessionMapItem): void {
    const title = h.labelEl.firstChild as HTMLDivElement;
    const sub = h.labelEl.lastChild as HTMLDivElement;
    title.textContent = (s.title || s.sessionId.slice(-8)).slice(0, 20);
    const parts: string[] = [];
    if (s.totalTokens > 0) parts.push(`${this.formatTokens(s.totalTokens)} tok`);
    if (s.lastToolName) parts.push(s.lastToolName);
    if (s.source === 'access-key' && s.keyName) parts.push(`🔑 ${s.keyName}`);
    sub.textContent = parts.join(' · ');
  }

  /** 标签显隐：全局开关打开时全部显示，否则仅选中节点显示（通过 label.visible，由 CSS2DRenderer 渲染） */
  private syncLabel(h: NodeHandle): void {
    h.label.visible = this.showAllLabels || h.sessionId === this.selectedId;
  }

  setLabelsVisible(all: boolean): void {
    if (this.showAllLabels === all) return;
    this.showAllLabels = all;
    const pe = all ? 'auto' : 'none'; // 开→可点选；关→不拦截鼠标
    for (const h of this.nodes.values()) {
      h.labelEl.style.pointerEvents = pe;
      h.labelEl.style.cursor = pe === 'auto' ? 'pointer' : 'default';
      this.syncLabel(h);
    }
  }

  private formatTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
    return `${n}`;
  }

  // ============================ 连线 ============================

  private createLink(sessionId: string, p: ReturnType<typeof worldFromSession>): void {
    const group = new THREE.Group();
    const w = this.container.clientWidth || 800;
    const h = this.container.clientHeight || 600;
    const resolution = new THREE.Vector2(w, h);
    const hasSplit = !!p.split; // 输入、输出都 >0 才分段两色；否则只画完整累计连线

    // 完整累计连线（输入/输出任一缺失时显示，单一颜色、完整不断）
    const bgMat = new LineMaterial({
      color: this.palette.active.getHex(), linewidth: 3, transparent: true,
      opacity: 0.85 + p.depth01 * 0.15, dashed: false,
    });
    bgMat.resolution = resolution;
    const bg = new Line2(this.makeLineGeo(APEX, p.pos), bgMat);

    // 输入段（顶点→split，主题绿）与输出段（split→节点，亮蓝）
    const segInMat = new LineMaterial({ color: this.palette.active.getHex(), linewidth: 3, transparent: true, opacity: 0.95 });
    segInMat.resolution = resolution;
    const segOutMat = new LineMaterial({ color: LINK_OUTPUT_COLOR, linewidth: 3, transparent: true, opacity: 0.95 });
    segOutMat.resolution = resolution;
    const split = p.split ?? p.pos;
    const segIn = new Line2(this.makeLineGeo(APEX, split), segInMat);
    const segOut = new Line2(this.makeLineGeo(split, p.pos), segOutMat);

    // 有输入+输出 → 只显示两段（隐藏累计）；任一缺失 → 只显示完整累计
    bg.visible = !hasSplit;
    segIn.visible = hasSplit;
    segOut.visible = hasSplit;

    group.add(bg, segIn, segOut);
    group.visible = this.linkVisible(sessionId);
    this.scene.add(group);
    this.links.set(sessionId, { group, bg, bgMat, segIn, segInMat, segOut, segOutMat });
  }

  /** 连线是否可见：开关开 → 全显；开关关 → 仅选中节点显示 */
  private linkVisible(sessionId: string): boolean {
    return this.showLinks || sessionId === this.selectedId;
  }

  /** 连线开关（选中节点的连线始终显示） */
  setLinksVisible(v: boolean): void {
    if (this.showLinks === v) return;
    this.showLinks = v;
    for (const [id, l] of this.links) l.group.visible = this.linkVisible(id);
  }

  private updateLink(l: LinkHandle, p: ReturnType<typeof worldFromSession>): void {
    const hasSplit = !!p.split;
    const split = p.split ?? p.pos;
    this.setLineGeo(l.bg.geometry as LineGeometry, APEX, p.pos);
    l.bgMat.opacity = 0.85 + p.depth01 * 0.15;
    this.setLineGeo(l.segIn.geometry as LineGeometry, APEX, split);
    this.setLineGeo(l.segOut.geometry as LineGeometry, split, p.pos);
    // 有输入+输出 → 两段（隐藏累计）；任一缺失 → 完整累计
    l.bg.visible = !hasSplit;
    l.segIn.visible = hasSplit;
    l.segOut.visible = hasSplit;
  }

  private makeLineGeo(a: THREE.Vector3, b: THREE.Vector3): LineGeometry {
    const g = new LineGeometry();
    g.setPositions([a.x, a.y, a.z, b.x, b.y, b.z]);
    return g;
  }
  private setLineGeo(g: LineGeometry, a: THREE.Vector3, b: THREE.Vector3): void {
    g.setPositions([a.x, a.y, a.z, b.x, b.y, b.z]);
  }

  // ============================ 交互 ============================

  setSelected(sessionId: string | null): void {
    if (this.selectedId === sessionId) return;
    this.applySelection(sessionId);
  }

  /** 显示选中节点的同色土星环（颜色随状态、尺寸随半径） */
  private showRing(h: NodeHandle): void {
    this.ringMat.color.copy(h.status === 'completed' ? this.completedNodeColor : this.palette[h.status]);
    this.ringMesh.scale.setScalar(h.radius * 1.8);
    this.ringPivot.visible = true;
  }

  private applySelection(sessionId: string | null): void {
    const prev = this.selectedId;
    this.selectedId = sessionId;
    if (prev) {
      const ph = this.nodes.get(prev); if (ph) { this.applyNodeAppearance(ph); this.syncLabel(ph); }
      const pl = this.links.get(prev); if (pl) pl.group.visible = this.linkVisible(prev);
    }
    if (!sessionId) { this.ringPivot.visible = false; return; }
    const h = this.nodes.get(sessionId);
    if (!h) { this.ringPivot.visible = false; return; }
    const nl = this.links.get(sessionId); if (nl) nl.group.visible = this.linkVisible(sessionId);
    this.applyNodeAppearance(h);
    this.syncLabel(h);
    this.showRing(h); // 选中节点显示同色土星环
  }

  focusSession(sessionId: string): void {
    const h = this.nodes.get(sessionId);
    if (!h) return;
    this.applySelection(sessionId);
    const offset = new THREE.Vector3(0, 4, 14);
    this.focusTarget = { cam: h.targetPos.clone().add(offset), look: h.targetPos.clone() };
  }

  resetCamera(): void {
    this.focusTarget = { cam: CAM_HOME.clone(), look: CAM_TARGET.clone() };
  }

  private refreshPickables(): void {
    this.pickables = [];
    for (const h of this.nodes.values()) this.pickables.push(h.sphere);
  }

  private onPointerDown = (e: PointerEvent): void => {
    this.downClient = { x: e.clientX, y: e.clientY };
    this.downCamPos.copy(this.camera.position);
    this.downCamQuat.copy(this.camera.quaternion);
    this.pointerDownTime = performance.now();
  };

  private onPointerUp = (e: PointerEvent): void => {
    const moved = Math.hypot(e.clientX - this.downClient.x, e.clientY - this.downClient.y);
    const camMoved = this.camera.position.distanceTo(this.downCamPos) > 1e-4
      || Math.abs(this.camera.quaternion.dot(this.downCamQuat)) < 0.9995;
    const dt = performance.now() - this.pointerDownTime;
    if (moved > 5 || camMoved || dt > 350) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.pickables, false);
    if (hits.length > 0) {
      const mesh = hits[0].object as THREE.Mesh;
      const h = this.findByMesh(mesh);
      this.cb.onSelect(h ? h.sessionId : null);
    } else {
      this.cb.onSelect(null);
    }
  };

  private findByMesh(mesh: THREE.Mesh): NodeHandle | null {
    for (const h of this.nodes.values()) if (h.sphere === mesh) return h;
    return null;
  }

  private onContextLost = (e: Event): void => {
    e.preventDefault();
    this.running = false;
    cancelAnimationFrame(this.rafId);
    this.cb.onContextLost?.();
  };

  private onVisibility = (): void => {
    if (document.hidden) {
      this.running = false;
      cancelAnimationFrame(this.rafId);
    } else if (!this.disposed && !this.running) {
      this.running = true;
      this.clock.getDelta();
      this.loop();
    }
  };

  // ============================ 渲染循环 ============================

  private loop = (): void => {
    if (!this.running || this.disposed) return;
    this.rafId = requestAnimationFrame(this.loop);
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const t = this.clock.elapsedTime;

    const lerpK = 1 - Math.exp(-dt * 6);
    for (const h of this.nodes.values()) {
      h.group.position.lerp(h.targetPos, lerpK);
      // 脉冲发光圈（仅进行中 active 节点）
      if (h.glow.visible) {
        h.glowMat.opacity = (0.4 + Math.sin(t * 2) * 0.2) * 0.5;
        h.glow.scale.setScalar(1 + Math.sin(t * 2) * 0.05);
      }
      if (h.inFlight > 0) {
        h.sphere.scale.setScalar(1 + Math.sin(t * 6) * 0.05);
      } else if (h.sphere.scale.x !== 1) {
        h.sphere.scale.setScalar(1);
      }
    }

    // 选中节点的土星环：跟随节点位置，持续绕 Y 轴旋转
    if (this.selectedId && this.ringPivot.visible) {
      const h = this.nodes.get(this.selectedId);
      if (h) {
        this.ringPivot.position.copy(h.group.position);
        this.ringPivot.rotation.y += dt * 0.8;
      } else {
        this.ringPivot.visible = false;
      }
    }

    if (this.focusTarget) {
      this.camera.position.lerp(this.focusTarget.cam, 1 - Math.exp(-dt * 3));
      this.controls.target.lerp(this.focusTarget.look, 1 - Math.exp(-dt * 3));
      if (this.camera.position.distanceTo(this.focusTarget.cam) < 0.1) this.focusTarget = null;
    }

    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.css2d.render(this.scene, this.camera);
  };

  // ============================ 尺寸 / 释放 ============================

  resize(): void {
    if (this.disposed) return;
    const w = this.container.clientWidth || 800;
    const h = this.container.clientHeight || 600;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.css2d.setSize(w, h);
    const res = new THREE.Vector2(w, h);
    for (const l of this.links.values()) { l.bgMat.resolution = res; l.segInMat.resolution = res; l.segOutMat.resolution = res; }
    if (this.axisMat) this.axisMat.resolution = res;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.running = false;
    cancelAnimationFrame(this.rafId);

    document.removeEventListener('visibilitychange', this.onVisibility);
    this.ro?.disconnect();
    this.mo?.disconnect();
    const el = this.renderer?.domElement;
    if (el) {
      el.removeEventListener('pointerdown', this.onPointerDown);
      el.removeEventListener('pointerup', this.onPointerUp);
      el.removeEventListener('webglcontextlost', this.onContextLost);
    }

    for (const h of [...this.nodes.values()]) this.disposeNode(h);
    this.nodes.clear();
    for (const l of [...this.links.values()]) this.disposeLink(l);
    this.links.clear();

    for (const g of this.sphereGeoms) g.dispose();
    for (const g of this.glowGeoms) g.dispose();
    for (const g of this.decalGeoms) g.dispose();
    this.ringMesh.geometry.dispose();
    this.ringMat.dispose();
    this.floor.geometry.dispose();
    (this.floor.material as THREE.Material).dispose();
    for (const r of this.floorRings) { r.mesh.geometry.dispose(); r.mat.dispose(); }
    this.apexMesh.geometry.dispose();
    this.apexMat.dispose();
    if (this.axisLine) { this.axisLine.geometry.dispose(); this.axisMat.dispose(); }
    for (const obj of this.axisLabels) { obj.element.remove(); obj.removeFromParent(); }
    this.axisLabels = [];

    this.controls?.dispose();
    for (const tex of this.logoTexCache.values()) tex.dispose();
    this.logoTexCache.clear();
    this.renderer?.dispose();

    if (el?.parentElement) el.parentElement.removeChild(el);
    const css2dDom = this.css2d?.domElement;
    if (css2dDom?.parentElement) css2dDom.parentElement.removeChild(css2dDom);
    if (this.probeEl.parentElement) this.probeEl.parentElement.removeChild(this.probeEl);
    this.renderer?.forceContextLoss?.();
  }

  private disposeNode(h: NodeHandle): void {
    this.scene.remove(h.group);
    h.sphereMat.dispose();
    h.glowMat.dispose();
    h.decalMat.dispose(); // 贴片 geometry 按桶共享，不在节点级释放
    h.labelEl.remove();
    h.label.removeFromParent();
  }

  private disposeLink(l: LinkHandle): void {
    this.scene.remove(l.group);
    l.bg.geometry.dispose();
    l.segIn.geometry.dispose();
    l.segOut.geometry.dispose();
    l.bgMat.dispose();
    l.segInMat.dispose();
    l.segOutMat.dispose();
  }
}

export type { SessionStatus };
