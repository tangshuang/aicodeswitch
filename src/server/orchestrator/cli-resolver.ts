/**
 * 跨平台 CLI 解析器
 *
 * 背景：在 Windows 上，npm 全局包以 `<name>.cmd` 批处理 shim 形式分发。
 * 直接 `spawn('<name>', ...)`（不带 shell:true）会因为 CreateProcess 不识别
 * .cmd 扩展名而 ENOENT；而加 shell:true 又会闪现 cmd.exe 控制台窗口。
 *
 * 解决：Windows 上用 `where` 定位 .cmd，再读取其内容解析出真正的 node 入口 JS
 * （npm shim 固定写法：`"<node>" "%dp0%\node_modules\<pkg>\<entry>.js" %*`），
 * 用 `process.execPath + [jsPath]` 直接调用，绕开 cmd.exe。
 *
 * 非 Windows 平台保持 `command=name, prependArgs=[]` 原样。
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

export interface ResolvedCli {
  /** 实际可执行命令（Windows 下解析成功时为 process.execPath） */
  command: string;
  /** 调用时需在用户参数前拼接的参数（Windows 下为 JS 入口路径） */
  prependArgs: string[];
}

const cache = new Map<string, ResolvedCli | null>();

/**
 * 解析 CLI 的真实可执行目标。
 * Windows 下优先解 .cmd shim；失败则回退到原命令（依赖系统 PATH 解析）。
 * 结果在进程生命周期内缓存。
 */
export function resolveCli(name: string): ResolvedCli {
  if (cache.has(name)) {
    const cached = cache.get(name);
    if (cached) return cached;
  }
  let resolved: ResolvedCli | null = null;
  if (process.platform === 'win32') {
    resolved = resolveWindowsShim(name);
  }
  if (!resolved) {
    resolved = { command: name, prependArgs: [] };
  }
  cache.set(name, resolved);
  return resolved;
}

/** Windows 专用：读 .cmd shim，提取 node_modules 下的 JS 入口路径 */
function resolveWindowsShim(name: string): ResolvedCli | null {
  let where: ReturnType<typeof spawnSync>;
  try {
    where = spawnSync('where', [name], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: 4000,
    });
  } catch {
    return null;
  }
  if (where.status !== 0 || !where.stdout) return null;

  const lines = where.stdout.toString().split(/\r?\n/).filter(Boolean);
  // 优先选 .cmd（npm 包标准 shim），其次 .ps1
  const cmdFile =
    lines.find((l) => l.toLowerCase().endsWith('.cmd')) ||
    lines.find((l) => l.toLowerCase().endsWith('.ps1'));
  if (!cmdFile) return null;

  try {
    const content = fs.readFileSync(cmdFile, 'utf-8');
    // 匹配 shim 里 node 调用：["...]%dp0%\node_modules\<pkg>\<entry>.js"
    // `%dp0%` 是 .cmd 文件所在目录（含末尾分隔符），需替换为真实路径
    // 同时兼容 .cmd（双引号）与 .ps1（单引号/双引号混用）
    const m = content.match(/["']?(%dp0%[\\/]node_modules[\\][^"'\s]+\.js)["']?/);
    if (!m) return null;
    const dir = path.dirname(cmdFile);
    const relative = m[1].replace(/^%dp0%[\\/]/i, '');
    const jsEntry = path.join(dir, relative);
    if (!fs.existsSync(jsEntry)) return null;
    return { command: process.execPath, prependArgs: [jsEntry] };
  } catch {
    return null;
  }
}

/** 健康检查：解析后的 CLI 能否成功执行 `<cmd> --version` */
export function isCliAvailable(name: string): boolean {
  const r = resolveCli(name);
  try {
    const result = spawnSync(r.command, [...r.prependArgs, '--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: 4000,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}
