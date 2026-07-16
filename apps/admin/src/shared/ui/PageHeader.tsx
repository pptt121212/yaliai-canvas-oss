import type { ReactNode } from 'react';

/**
 * 页面头：统一「标题 + 一句说明 + 右侧操作」结构。
 * 替代把标题塞进第一张 Card.title 的做法。
 */
export function PageHeader({
  title,
  desc,
  actions,
}: {
  title: ReactNode;
  desc?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="page-header">
      <div className="page-header__titles">
        <h1 className="page-header__title">{title}</h1>
        {desc ? <p className="page-header__desc">{desc}</p> : null}
      </div>
      {actions ? <div className="page-header__actions">{actions}</div> : null}
    </div>
  );
}
