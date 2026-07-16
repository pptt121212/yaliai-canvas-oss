import fs from 'node:fs';
import path from 'node:path';

export type JsonStoreOptions<T> = {
  envDirKey?: string;
  defaultDirName?: string;
  fileName: string;
  createDefault: () => T;
  mergeOnRead?: (input: unknown) => T;
};

export type JsonStore<T> = {
  getFilePath: () => string;
  read: () => T;
  write: (value: T) => void;
};

function resolveStoreDir(envDirKey?: string, defaultDirName = 'data') {
  const envValue = envDirKey ? process.env[envDirKey] : '';
  if (envValue) {
    return path.resolve(envValue);
  }
  return path.resolve(process.cwd(), defaultDirName);
}

export function createJsonStore<T>(options: JsonStoreOptions<T>): JsonStore<T> {
  const storeDir = resolveStoreDir(options.envDirKey, options.defaultDirName);
  const filePath = path.join(storeDir, options.fileName);

  function ensureStorage() {
    if (!fs.existsSync(storeDir)) {
      fs.mkdirSync(storeDir, { recursive: true });
    }
    if (!fs.existsSync(filePath)) {
      const seed = options.createDefault();
      fs.writeFileSync(filePath, JSON.stringify(seed, null, 2), 'utf8');
    }
  }

  return {
    getFilePath() {
      return filePath;
    },
    read() {
      ensureStorage();
      try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(raw) as unknown;
        return options.mergeOnRead ? options.mergeOnRead(parsed) : (parsed as T);
      } catch {
        return options.createDefault();
      }
    },
    write(value: T) {
      ensureStorage();
      fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
    },
  };
}
