import { createInflate } from 'node:zlib';

const pngSignature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
const maxPngValidationOutputBytes = 96 * 1024 * 1024;
const maxConcurrentPngValidations = 2;

let activePngValidations = 0;
const pendingPngValidations: Array<() => void> = [];

async function withPngValidationSlot<T>(operation: () => Promise<T>): Promise<T> {
  if (activePngValidations >= maxConcurrentPngValidations) {
    await new Promise<void>((resolve) => pendingPngValidations.push(resolve));
  }
  activePngValidations += 1;
  try {
    return await operation();
  } finally {
    activePngValidations -= 1;
    pendingPngValidations.shift()?.();
  }
}

function readPngIdatPayload(buffer: Buffer): Buffer | null {
  if (buffer.length < pngSignature.length || !buffer.subarray(0, pngSignature.length).equals(pngSignature)) {
    return null;
  }

  let offset = pngSignature.length;
  let sawHeader = false;
  let sawImageData = false;
  const imageDataChunks: Buffer[] = [];

  while (offset < buffer.length) {
    if (offset + 12 > buffer.length) {
      return null;
    }
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (dataEnd < dataStart || chunkEnd > buffer.length) {
      return null;
    }

    if (!sawHeader) {
      if (type !== 'IHDR' || length !== 13) {
        return null;
      }
      const width = buffer.readUInt32BE(dataStart);
      const height = buffer.readUInt32BE(dataStart + 4);
      if (!width || !height) {
        return null;
      }
      sawHeader = true;
    } else if (type === 'IDAT') {
      sawImageData = true;
      imageDataChunks.push(buffer.subarray(dataStart, dataEnd));
    } else if (type === 'IEND') {
      return sawImageData && length === 0 && chunkEnd === buffer.length
        ? Buffer.concat(imageDataChunks)
        : null;
    }
    offset = chunkEnd;
  }

  return null;
}

async function verifyPngCompression(imageData: Buffer): Promise<boolean> {
  return new Promise((resolve) => {
    const inflater = createInflate();
    let outputBytes = 0;
    let settled = false;
    const finish = (valid: boolean) => {
      if (!settled) {
        settled = true;
        resolve(valid);
      }
    };

    inflater.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > maxPngValidationOutputBytes) {
        inflater.destroy();
        finish(false);
      }
    });
    inflater.once('error', () => finish(false));
    inflater.once('end', () => finish(true));
    inflater.end(imageData);
  });
}

export async function isValidPngUpload(buffer: Buffer): Promise<boolean> {
  const imageData = readPngIdatPayload(buffer);
  if (!imageData) {
    return false;
  }
  return withPngValidationSlot(() => verifyPngCompression(imageData));
}
