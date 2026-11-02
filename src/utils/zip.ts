/**
 * Minimal ZIP writer (no dependencies).
 *
 * Produces a standard ZIP archive using DEFLATE compression via node:zlib, so
 * a project directory can be handed to Telegram as one document without
 * pulling in an archive library. Names are flagged as UTF-8, which every
 * modern extractor honours.
 *
 * Only the subset needed for "download my project" is implemented: files with
 * a relative path, a modification time and raw bytes. Directory entries are
 * implicit (their paths appear inside file names), which keeps the writer
 * small and the archives valid everywhere.
 */

import { crc32, deflateRawSync } from 'node:zlib';

export interface ZipEntryInput {
  /** Path inside the archive — always forward slashes, relative to the root. */
  name: string;
  data: Buffer;
  /** Modification time (defaults to now). */
  mtime?: Date;
}

/** Extra field flag: file names are UTF-8 (bit 11 of the general purpose flag). */
const UTF8_FLAG = 0x0800;
const METHOD_DEFLATE = 8;
const METHOD_STORE = 0;

function dosDateTime(value: Date): { time: number; date: number } {
  const year = Math.min(2107, Math.max(1980, value.getFullYear()));
  return {
    time: (value.getHours() << 11) | (value.getMinutes() << 5) | (value.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((value.getMonth() + 1) << 5) | value.getDate(),
  };
}

/**
 * Builds a ZIP archive in memory.
 *
 * Each entry is deflated; when compression does not actually help (already
 * compressed media) the original bytes are stored instead, so the archive is
 * never larger than the input.
 */
export function buildZip(entries: ZipEntryInput[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data) >>> 0;
    const deflated = deflateRawSync(entry.data);
    const useDeflate = deflated.length < entry.data.length;
    const payload = useDeflate ? deflated : entry.data;
    const method = useDeflate ? METHOD_DEFLATE : METHOD_STORE;
    const { time, date } = dosDateTime(entry.mtime ?? new Date());

    // Local file header (30 bytes) + name + payload.
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(UTF8_FLAG, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    localParts.push(local, nameBuf, payload);

    // Central directory record (46 bytes) + name.
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // signature
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(UTF8_FLAG, 8); // flags
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk number start
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(0, 38); // external attributes
    central.writeUInt32LE(offset, 42); // local header offset
    centralParts.push(central, nameBuf);

    offset += local.length + nameBuf.length + payload.length;
  }

  const centralBuf = Buffer.concat(centralParts);

  // End of central directory (22 bytes).
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // signature
  eocd.writeUInt16LE(0, 4); // this disk
  eocd.writeUInt16LE(0, 6); // disk with central directory
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localParts, centralBuf, eocd]);
}
