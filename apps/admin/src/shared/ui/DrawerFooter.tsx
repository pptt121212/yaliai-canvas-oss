import type { ReactNode } from 'react';

/**
 * 抽屉底部操作栏内容。配合 antd Drawer 的 `footer` 属性使用：
 *   <Drawer footer={<DrawerFooter> ...按钮 </DrawerFooter>}>
 * 右对齐排列，左侧可放次操作。
 */
export function DrawerFooter({ children }: { children: ReactNode }) {
  return <div className="drawer-footer">{children}</div>;
}
