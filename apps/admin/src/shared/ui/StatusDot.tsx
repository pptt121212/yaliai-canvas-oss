import type { ReactNode } from 'react';

export type StatusTone = 'success' | 'warning' | 'danger' | 'processing' | 'neutral';

/**
 * 状态点：8px 语义色圆点 + 文字。
 * 替代散落的实心 Tag，弱化色块、保证颜色不是唯一区分（始终带文字）。
 */
export function StatusDot({
  tone = 'neutral',
  children,
}: {
  tone?: StatusTone;
  children: ReactNode;
}) {
  return (
    <span className={`status-dot status-dot--${tone}`}>
      <span className="status-dot__mark" />
      <span>{children}</span>
    </span>
  );
}
