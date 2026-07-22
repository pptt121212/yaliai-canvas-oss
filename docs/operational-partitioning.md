# 高容量运行明细存储

请求追踪、计费流水、异步任务和长期租户资金账本都按 UTC 月分区。每条明细的
业务 ID 另写入极小的全局定位表，保存 `ID -> created_at`：

- 分区表负责按时间范围写入、查询和整月回收。
- 全局定位表负责 `trace_id`、计费 ID、任务 ID、资金账本 ID 的唯一性和幂等。
- `tenant_credit_balances` 与 `tenant_finance_balances` 仍是余额权威状态，和明细写入
  在同一事务中完成；清理追踪或计费明细不会改变余额。
- 当前月与下月启动时预建。写入路径只命中定位表和一个目标分区，不会为每个请求执行 DDL。

## 调度与报表

经营报表的定时 Rollup 只重建最近 1 到 3 个已关闭日桶，默认 2 天。历史回填使用
`pnpm --filter @yali/api rollup:operational -- --from=... --to=...`，不允许定时任务反复扫描数周原始明细。

## 一次性切换

这套系统不保留旧单表运行兼容层。上线前，在 API 服务停止后运行：

```powershell
$env:OPERATIONAL_PARTITION_RESET_CONFIRM = 'RESET_OPERATIONAL_DETAILS'
pnpm --filter @yali/api build
pnpm --filter @yali/api reset:operational-partitions
```

该操作清空请求追踪、计费明细、任务明细和资金账本历史，保留 `tenant_credit_balances`、
`tenant_finance_balances`、审计日志。账户当前余额不受影响。完成后再启动 API 服务。

## 验证

```powershell
pnpm --filter @yali/api build
pnpm --filter @yali/api verify:operational-partitions
```
