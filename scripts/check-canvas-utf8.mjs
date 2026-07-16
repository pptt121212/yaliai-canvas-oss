import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '..');
const targetDir = path.join(rootDir, 'packages', 'canvas-core', 'src');
const textExtensions = new Set([
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.css',
  '.html',
  '.json',
  '.md',
]);

const suspiciousFragments = [
  '鍥惧',
  '鐢诲',
  '绋嶅',
  '缁撴',
  '鍙',
  '鏌ョ湅',
  '鍔¤',
  '鐘舵',
  '鎺ュ',
  '锛岃',
  '銆',
];

async function collectFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return collectFiles(fullPath);
    }
    return [fullPath];
  }));
  return files.flat();
}

function hasSuspiciousContent(text) {
  if (text.includes('\uFFFD')) {
    return 'contains replacement character U+FFFD';
  }
  for (const fragment of suspiciousFragments) {
    if (text.includes(fragment)) {
      return `contains suspicious mojibake fragment "${fragment}"`;
    }
  }
  if (text.charCodeAt(0) === 0xFEFF) {
    return 'contains UTF-8 BOM';
  }
  return '';
}

async function main() {
  const files = await collectFiles(targetDir);
  const issues = [];

  for (const filePath of files) {
    if (!textExtensions.has(path.extname(filePath).toLowerCase())) {
      continue;
    }

    let text = '';
    try {
      text = await readFile(filePath, 'utf8');
    } catch (error) {
      issues.push(`${path.relative(rootDir, filePath)}: failed to decode as UTF-8 (${error.message})`);
      continue;
    }

    const issue = hasSuspiciousContent(text);
    if (issue) {
      issues.push(`${path.relative(rootDir, filePath)}: ${issue}`);
    }
  }

  if (issues.length) {
    console.error('Canvas UTF-8 check failed:');
    for (const issue of issues) {
      console.error(`- ${issue}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log('Canvas UTF-8 check passed.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
