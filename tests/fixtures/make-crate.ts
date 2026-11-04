/**
 * Test-only writer of `.crate` bytes in the layout documented in
 * docs/serato-format-notes.md section 3. Synthetic data only.
 */
export type CrateSpec = {
  version?: string;
  columns?: { name: string; width?: string }[];
  sort?: { column: string; reverse?: boolean };
  tracks?: string[];
  /** Extra top-level records appended after the tracks: [tag, payload]. */
  extra?: [string, Uint8Array][];
};

export function u32be(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, false);
  return b;
}

export function utf16be(s: string): Uint8Array {
  const b = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    b[i * 2] = c >> 8;
    b[i * 2 + 1] = c & 0xff;
  }
  return b;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function record(tag: string, payload: Uint8Array): Uint8Array {
  const t = new Uint8Array(4);
  for (let i = 0; i < 4; i++) t[i] = tag.charCodeAt(i);
  return concat(t, u32be(payload.length), payload);
}

export function textRecord(tag: string, s: string): Uint8Array {
  return record(tag, utf16be(s));
}

export function makeCrate(spec: CrateSpec = {}): Uint8Array {
  const parts: Uint8Array[] = [textRecord("vrsn", spec.version ?? "1.0/Serato ScratchLive Crate")];
  if (spec.sort) {
    parts.push(
      record(
        "osrt",
        concat(
          textRecord("tvcn", spec.sort.column),
          record("brev", new Uint8Array([spec.sort.reverse ? 1 : 0])),
        ),
      ),
    );
  }
  for (const c of spec.columns ?? []) {
    parts.push(
      record("ovct", concat(textRecord("tvcn", c.name), textRecord("tvcw", c.width ?? "0"))),
    );
  }
  for (const t of spec.tracks ?? []) parts.push(record("otrk", textRecord("ptrk", t)));
  for (const [tag, payload] of spec.extra ?? []) parts.push(record(tag, payload));
  return concat(...parts);
}
