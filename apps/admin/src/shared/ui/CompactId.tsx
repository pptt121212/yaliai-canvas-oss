import { Typography } from 'antd';
import { App } from 'antd';

const { Text } = Typography;

/**
 * 紧凑 ID / 可复制文本：中段省略 + 等宽字体 + 点击复制。
 * hover 显示完整值（antd Text copyable + tooltip 由 title 提供）。
 */
export function CompactId({
  value,
  maxLength = 18,
  head = 10,
  tail = 6,
}: {
  value?: string;
  maxLength?: number;
  head?: number;
  tail?: number;
}) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return <Text type="secondary">—</Text>;
  }
  const shortValue =
    normalized.length > maxLength
      ? `${normalized.slice(0, head)}…${normalized.slice(-tail)}`
      : normalized;
  return (
    <Text
      code
      copyable={{ text: normalized }}
      className="compact-id"
      title={normalized}
    >
      {shortValue}
    </Text>
  );
}

/**
 * 单行省略文本 + hover 完整值。
 */
export function EllipsisText({ value }: { value?: string }) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return <Text type="secondary">—</Text>;
  }
  return (
    <Text className="table-ellipsis" title={normalized}>
      {normalized}
    </Text>
  );
}

/**
 * 可复制的纯文本按钮式封装（接口地址、完整 Key 等）。
 */
export function useCopy() {
  const { message } = App.useApp();
  return async (text: string, successText = '已复制') => {
    await navigator.clipboard.writeText(text);
    message.success(successText);
  };
}
