import type { ReactNode } from 'react';

/**
 * 区块标题：小标题 + 可选一行说明。
 * 用于抽屉 / 长表单分组，替代一连串 <Divider>，更清晰、更省高度。
 */
export function SectionTitle({
  children,
  desc,
}: {
  children: ReactNode;
  desc?: ReactNode;
}) {
  return (
    <div className="section-title">
      <div className="section-title__label">{children}</div>
      {desc ? <p className="section-title__desc">{desc}</p> : null}
    </div>
  );
}
