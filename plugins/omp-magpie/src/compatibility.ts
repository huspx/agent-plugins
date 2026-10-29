export const MIN_OMP_VERSION = '18.4.4';
export const VERIFIED_OMP_VERSION = '18.12.6';

const stableVersion = /^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const minimumParts = MIN_OMP_VERSION.split('.');

/**
 * 只允许最低版本起的稳定 OMP；可带 v 前缀与合法构建元数据，后者不参与排序。
 * 非法版本或预发布版本返回 false；允许加载不代表已经在该版本运行验证。
 */
export function isSupportedHostVersion(version: string): boolean {
  const match = stableVersion.exec(version);
  if (!match || match[0] !== version) return false;
  for (let index = 0; index < minimumParts.length; index++) {
    const actual = match[index + 1]!;
    const minimum = minimumParts[index]!;
    // 无前导零的十进制先比较长度，再按字典序比较，避免大版本号发生数值精度损失。
    if (actual.length !== minimum.length) return actual.length > minimum.length;
    if (actual !== minimum) return actual > minimum;
  }
  return true;
}
