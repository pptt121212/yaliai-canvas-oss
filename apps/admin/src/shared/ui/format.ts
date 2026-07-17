/**
 * 统一格式化工具。
 * 时间：YYYY-MM-DD HH:mm:ss（24h）；金额：分 → ￥元；空值：— 。
 */

import { formatCnyMinorUnits } from '@yali/billing-core';

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

/** Integer 0.00001-yuan units -> formatted CNY. */
export function formatCredits(cents?: number | null): string {
  return `￥${formatCnyMinorUnits(cents, 2)}`;
}

/** Operational reports use the same precise accounting unit as financial balances. */
export function formatReportCostCredits(cents?: number | null): string {
  return `￥${formatCnyMinorUnits(cents, 2)}`;
}

/** 空值统一显示为 em dash */
export const EMPTY_DASH = DASH;
