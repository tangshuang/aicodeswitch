/**
 * 把字节数格式化为带单位的可读字符串（1024 进制：B / KB / MB / GB / TB / PB）。
 * value >= 100 或为 B 时取整，其余保留 1 位小数。
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  const formatted = value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1);
  return `${formatted} ${units[i]}`;
}
