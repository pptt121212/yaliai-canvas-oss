declare module 'pg' {
  export type PoolConfig = {
    connectionString?: string;
    max?: number;
  };

  export class Pool {
    constructor(config?: PoolConfig);
    query(sql: string, values?: unknown[]): Promise<{ rowCount: number; rows: Array<Record<string, any>> }>;
  }
}

declare module 'redis' {
  export type RedisClientType = {
    isOpen: boolean;
    connect(): Promise<void>;
    get(key: string): Promise<string | null>;
    set(key: string, value: string, options?: { EX?: number }): Promise<unknown>;
    del(key: string): Promise<unknown>;
    keys(pattern: string): Promise<string[]>;
    mGet(keys: string[]): Promise<Array<string | null>>;
    sendCommand(args: string[]): Promise<unknown>;
  };

  export function createClient(options?: { url?: string }): RedisClientType;
}
