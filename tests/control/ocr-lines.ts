import type { OcrLine, OcrWindow } from "../../src/control/platform.js";

/** One OCR line whose words are laid out left to right from (x, y). */
export function line(text: string, x = 0, y = 0): OcrLine {
  let cx = x;
  return {
    text,
    words: text.split(" ").map((t) => {
      const w = { text: t, x: cx, y, width: t.length * 6, height: 8 };
      cx += w.width + 6;
      return w;
    }),
  };
}

export const shot = (...lines: OcrLine[]): OcrWindow => ({
  window: { left: 0, top: 0, width: 1920, height: 1080 },
  lines,
});
