// Read only GETs against public federal APIs, with retries and a small concurrency pool.
import { inflateRawSync } from "node:zlib";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function getJSON<T = any>(url: string, tries = 4): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(90_000) });
      if (r.ok) return (await r.json()) as T;
      last = new Error(`HTTP ${r.status} for ${url}`);
      if (r.status >= 400 && r.status < 500 && r.status !== 429) break;
    } catch (e) {
      last = e;
    }
    await sleep(1000 * (i + 1));
  }
  throw last;
}

/** Runs fn over items with at most `width` in flight, keeping input order in the result. */
export async function pool<T, R>(items: T[], width: number, fn: (item: T, i: number) => Promise<R>, pauseMs = 0): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
      if (pauseMs) await sleep(pauseMs);
    }
  }
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, worker));
  return out;
}

async function range(url: string, start: number, end: number): Promise<Buffer> {
  const r = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, signal: AbortSignal.timeout(600_000) });
  if (r.status !== 206) throw new Error(`range request refused (${r.status}) for ${url}`);
  return Buffer.from(await r.arrayBuffer());
}

interface ZipEntry { name: string; method: number; comp: number; unc: number; offset: number }

/** Lists a zip's central directory, from a Buffer or from a remote file read by HTTP range (zip64 aware). */
function centralDirectory(tail: Buffer, tailStart: number): { entries: ZipEntry[]; cdOff: number } {
  const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error("no zip end of central directory");
  let n = tail.readUInt16LE(eocd + 10);
  let cdOff = tail.readUInt32LE(eocd + 16);
  const z64 = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x06, 0x06]));
  if (z64 >= 0) {
    n = Number(tail.readBigUInt64LE(z64 + 32));
    cdOff = Number(tail.readBigUInt64LE(z64 + 48));
  }
  const entries: ZipEntry[] = [];
  let p = cdOff - tailStart;
  for (let i = 0; i < n; i++) {
    if (p < 0 || tail.readUInt32LE(p) !== 0x02014b50) throw new Error("central directory not in the bytes read");
    const method = tail.readUInt16LE(p + 10);
    let comp = tail.readUInt32LE(p + 20), unc = tail.readUInt32LE(p + 24);
    const fl = tail.readUInt16LE(p + 28), el = tail.readUInt16LE(p + 30), cl = tail.readUInt16LE(p + 32);
    let offset = tail.readUInt32LE(p + 42);
    const name = tail.subarray(p + 46, p + 46 + fl).toString("latin1");
    let e = p + 46 + fl;
    const eEnd = e + el;
    while (e < eEnd) {
      const id = tail.readUInt16LE(e), sz = tail.readUInt16LE(e + 2);
      if (id === 1) {
        let q = e + 4;
        if (unc === 0xffffffff) { unc = Number(tail.readBigUInt64LE(q)); q += 8; }
        if (comp === 0xffffffff) { comp = Number(tail.readBigUInt64LE(q)); q += 8; }
        if (offset === 0xffffffff) offset = Number(tail.readBigUInt64LE(q));
      }
      e += 4 + sz;
    }
    entries.push({ name, method, comp, unc, offset });
    p = eEnd + cl;
  }
  return { entries, cdOff };
}

function inflateEntry(data: Buffer, method: number): Buffer {
  if (method === 0) return data;
  if (method === 8) return inflateRawSync(data);
  throw new Error(`zip compression method ${method} not supported`);
}

/** Reads one member of a remote zip with HTTP range requests, without downloading the rest of the archive. */
export async function remoteZipMember(url: string, match: (name: string) => boolean): Promise<{ name: string; bytes: Buffer }> {
  const head = await fetch(url, { method: "HEAD" });
  const size = Number(head.headers.get("content-length"));
  const tailLen = Math.min(size, 1 << 18);
  const tail = await range(url, size - tailLen, size - 1);
  const { entries } = centralDirectory(tail, size - tailLen);
  const hit = entries.find((e) => match(e.name));
  if (!hit) throw new Error(`no member matched in ${url}: ${entries.map((e) => e.name).join(", ")}`);
  const local = await range(url, hit.offset, hit.offset + 29);
  const dataStart = hit.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
  const data = await range(url, dataStart, dataStart + hit.comp - 1);
  return { name: hit.name, bytes: inflateEntry(data, hit.method) };
}

/** Unzips every member of an in memory zip. */
export function unzip(buf: Buffer): Map<string, Buffer> {
  const { entries } = centralDirectory(buf, 0);
  const out = new Map<string, Buffer>();
  for (const e of entries) {
    const dataStart = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28);
    out.set(e.name, inflateEntry(buf.subarray(dataStart, dataStart + e.comp), e.method));
  }
  return out;
}
