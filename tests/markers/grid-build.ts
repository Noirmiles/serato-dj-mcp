/** Synthetic byte builders for Serato grid tags. */
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const f32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeFloatBE(n);
  return b;
};
const f64 = (n: number) => {
  const b = Buffer.alloc(8);
  b.writeDoubleBE(n);
  return b;
};
const i64 = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigInt64BE(n);
  return b;
};

export type TM = {
  pos: bigint;
  tempo: number;
  note: number;
  interp: number;
  curv?: number;
  time?: number;
};

export const tempoMapV2 = (ms: TM[], origin = 0.05, header = 0x0102, mode = 1): Buffer =>
  Buffer.concat([
    Buffer.from([2, header >> 8, header & 0xff, mode]),
    f64(origin),
    u32(ms.length),
    ...ms.map((m) =>
      Buffer.concat([
        i64(m.pos),
        f64(m.tempo),
        f64(m.note),
        Buffer.from([m.interp]),
        f64(m.curv ?? 0),
      ]),
    ),
  ]);

export const tempoMapV1 = (ms: TM[]): Buffer =>
  Buffer.concat([
    Buffer.from([1]),
    u32(ms.length),
    ...ms.map((m) =>
      Buffer.concat([
        f64(m.time ?? 0),
        i64(m.pos),
        f64(m.tempo),
        f64(m.note),
        Buffer.from([m.interp]),
      ]),
    ),
  ]);

/** Non-terminal markers {sec, beats}, then the terminal {sec, bpm}. */
export const beatGrid = (
  nonTerminal: [number, number][],
  last: [number, number],
  footer = true,
): Buffer =>
  Buffer.concat([
    Buffer.from([1, 0]),
    u32(nonTerminal.length + 1),
    ...nonTerminal.map(([s, n]) => Buffer.concat([f32(s), u32(n)])),
    f32(last[0]),
    f32(last[1]),
    ...(footer ? [Buffer.from([0])] : []),
  ]);
