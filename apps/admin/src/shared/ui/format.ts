/**
 * 统一格式化工具。
 * 时间：YYYY-MM-DD HH:mm:ss（24h）；金额：分 → ￥元；空值：— 。
 */

const DASH = '—';

export function formatDateTime(value?: number | null): string {
  if (!value) {
    return DASH;
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    return DASH;
  }
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/** 分 → ￥元，保留两位小数 */
export function formatCredits(cents?: number | null): string {
  return `￥${(Number(cents || 0) / 100).toFixed(2)}`;
}

/** 空值统一显示为 em dash */
export const EMPTY_DASH = DASH;
