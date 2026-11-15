const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
/** Check actual inflation, not just attacker-controlled declared ZIP sizes. No paths are written. */
export async function verifyZipContents(bytes: Uint8Array, fail: () => never) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    max = 16 * 1024 * 1024;
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--)
    if (
      view.getUint32(i, true) === 0x06054b50 &&
      i + 22 + view.getUint16(i + 20, true) === bytes.length
    ) {
      end = i;
      break;
    }
  if (end < 0) fail();
  const count = view.getUint16(end + 10, true),
    central = view.getUint32(end + 16, true);
  if (
    view.getUint32(end + 4, true) !== 0 ||
    count < 1 ||
    count > 128 ||
    view.getUint16(end + 8, true) !== count ||
    central + view.getUint32(end + 12, true) !== end
  )
    fail();
  let offset = central,
    total = 0;
  const names = new Set<string>(),
    locations = new Set<number>();
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) fail();
    const flags = view.getUint16(offset + 8, true),
      method = view.getUint16(offset + 10, true),
      crc = view.getUint32(offset + 16, true),
      compressed = view.getUint32(offset + 20, true),
      size = view.getUint32(offset + 24, true),
      nameLength = view.getUint16(offset + 28, true),
      extra = view.getUint16(offset + 30, true),
      comment = view.getUint16(offset + 32, true),
      local = view.getUint32(offset + 42, true);
    const name = new TextDecoder('utf-8', { fatal: true }).decode(
      bytes.subarray(offset + 46, offset + 46 + nameLength),
    );
    if (
      offset + 46 + nameLength + extra + comment > end ||
      flags & 1 ||
      ![0, 8].includes(method) ||
      size > max ||
      total + size > max ||
      names.has(name) ||
      locations.has(local) ||
      name.includes('..') ||
      name.startsWith('/') ||
      name.includes('\\') ||
      local + 30 > central
    )
      fail();
    names.add(name);
    locations.add(local);
    if (
      view.getUint32(local, true) !== 0x04034b50 ||
      view.getUint16(local + 8, true) !== method ||
      view.getUint16(local + 6, true) !== flags
    )
      fail();
    const localName = view.getUint16(local + 26, true),
      start = local + 30 + localName + view.getUint16(local + 28, true);
    if (
      start + compressed > central ||
      new TextDecoder().decode(bytes.subarray(local + 30, local + 30 + localName)) !== name
    )
      fail();
    const data = bytes.slice(start, start + compressed);
    const input = new Blob([data]).stream();
    const stream = method === 0 ? input : input.pipeThrough(new DecompressionStream('deflate-raw'));
    const reader = stream.getReader();
    let actual = 0,
      check = 0xffffffff;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        actual += chunk.value.byteLength;
        total += chunk.value.byteLength;
        if (actual > size || total > max) fail();
        for (const byte of chunk.value) check = crcTable[(check ^ byte) & 255]! ^ (check >>> 8);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    if (actual !== size || (check ^ 0xffffffff) >>> 0 !== crc) fail();
    offset += 46 + nameLength + extra + comment;
  }
  if (offset !== end) fail();
  return names;
}
