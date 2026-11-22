import { assertSignal } from '../util';

const crcTable = new Uint32Array(256).map((_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});

// Names Windows refuses to create, regardless of extension.
const reservedNames = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const maxBaseLength = 180;

function uniqueName(name: string, used: Set<string>): string {
  const safe =
    name
      .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
      .replace(/^\.+/, '')
      .replace(/[. ]+$/, '') || 'image';
  const dot = safe.lastIndexOf('.');
  let base = dot > 0 ? safe.slice(0, dot) : safe;
  const ext = dot > 0 ? safe.slice(dot) : '';
  base = Array.from(base).slice(0, maxBaseLength).join('');
  base = base.replace(/[. ]+$/, '') || 'image';
  if (reservedNames.test(base)) base = `_${base}`;
  let result = base + ext;
  let index = 2;
  while (used.has(result.toLowerCase())) result = `${base}-${index++}${ext}`;
  used.add(result.toLowerCase());
  return result;
}

/** MS-DOS time and date fields used by ZIP headers (local time, 2 s precision). */
function dosDateTime(date: Date): [number, number] {
  const valid = Number.isFinite(date.getTime());
  const year = valid ? date.getFullYear() : 1980;
  if (year < 1980) return [0, 33];
  const clampedYear = Math.min(2107, year);
  const time = valid
    ? (date.getHours() << 11) |
      (date.getMinutes() << 5) |
      (date.getSeconds() >> 1)
    : 0;
  const day = valid
    ? ((clampedYear - 1980) << 9) |
      ((date.getMonth() + 1) << 5) |
      date.getDate()
    : 33;
  return [time, day];
}

// Store already-compressed images without recompressing them; check ZIP32 limits explicitly.
export async function createZip(
  files: File[],
  signal: AbortSignal,
  onProgress: (completed: number) => void = () => {},
  date: Date = new Date(),
): Promise<Blob> {
  if (files.length > 65535) throw new Error('ZIP 文件数量超过限制');
  const parts: BlobPart[] = [];
  const directory: Uint8Array[] = [];
  const used = new Set<string>();
  const [dosTime, dosDate] = dosDateTime(date);
  let offset = 0;
  let directorySize = 0;
  for (const [index, file] of files.entries()) {
    assertSignal(signal);
    const name = new TextEncoder().encode(uniqueName(file.name, used));
    if (
      name.length > 65535 ||
      file.size >= 0xffffffff ||
      offset + file.size + name.length + 30 >= 0xffffffff
    ) {
      throw new Error('ZIP 超过 4 GB，请分批下载');
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    let crc = 0xffffffff;
    for (let start = 0; start < bytes.length; start += 1024 * 1024) {
      assertSignal(signal);
      const end = Math.min(start + 1024 * 1024, bytes.length);
      for (let i = start; i < end; i++)
        crc = crcTable[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assertSignal(signal);
    crc = (crc ^ 0xffffffff) >>> 0;
    const local = new Uint8Array(30 + name.length);
    const view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 0x0800, true);
    view.setUint16(10, dosTime, true);
    view.setUint16(12, dosDate, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, file.size, true);
    view.setUint32(22, file.size, true);
    view.setUint16(26, name.length, true);
    local.set(name, 30);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, file.size, true);
    cv.setUint32(24, file.size, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    parts.push(local, file);
    directory.push(central);
    offset += local.length + file.size;
    directorySize += central.length;
    onProgress(index + 1);
  }
  if (offset + directorySize + 22 >= 0xffffffff)
    throw new Error('ZIP 超过 4 GB，请分批下载');
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, directorySize, true);
  ev.setUint32(16, offset, true);
  assertSignal(signal);
  return new Blob([...parts, ...directory, end], { type: 'application/zip' });
}
