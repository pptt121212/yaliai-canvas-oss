/**
 * 统一的代码 / JSON 区块：浅色底 + 描边 + 等宽字体。
 * 传入对象则自动 JSON.stringify；传入字符串直接展示。
 */
export function CodeBlock({
  value,
  maxHeight = 320,
}: {
  value: unknown;
  maxHeight?: number;
}) {
  const text =
    typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return (
    <pre className="code-block" style={{ maxHeight }}>
      {text}
    </pre>
  );
}
