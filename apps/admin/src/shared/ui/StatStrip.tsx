import type { ReactNode } from 'react';

export type StatItem = {
  label: ReactNode;
  value: ReactNode;
  /** 值是否用次要色（用于「0 失败」这类不需要强调的项） */
  muted?: boolean;
};

/**
 * 统计条：把一排独立的大统计卡合并成一条紧凑分栏卡片。
 * 栏间发丝竖线，数值等宽，高度紧凑。响应式下降为 2 列 / 1 列（见 styles.css）。
 */
export function StatStrip({ items }: { items: StatItem[] }) {
  return (
    <div className="stat-strip">
      {items.map((item, index) => (
        <div className="stat-strip__item" key={index}>
          <div className="stat-strip__label">{item.label}</div>
          <div
            className={
              item.muted
                ? 'stat-strip__value stat-strip__value--muted'
                : 'stat-strip__value'
            }
          >
            {item.value}
          </div>
        </div>
      ))}
    </div>
  );
}
