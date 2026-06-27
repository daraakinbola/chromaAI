import type { CurveState, ToneCurve, ParametricCurve } from "@/types";

// ─── LUT builder — monotone cubic Hermite interpolation (Fritsch-Carlson) ────
// Guarantees no oscillations / reversals between control points.

export function buildCurveLUT(points: [number, number][]): Float32Array {
  const lut = new Float32Array(256);

  const sorted = [...points]
    .sort((a, b) => a[0] - b[0])
    .filter((p, i, arr) => i === 0 || p[0] !== arr[i - 1][0]);

  if (sorted.length === 0) {
    for (let i = 0; i < 256; i++) lut[i] = i / 255;
    return lut;
  }

  if (sorted.length === 1) {
    const [px, py] = sorted[0];
    for (let i = 0; i < 256; i++)
      lut[i] = Math.max(0, Math.min(1, (i - px + py) / 255));
    return lut;
  }

  const n = sorted.length;
  const xs = sorted.map((p) => p[0]);
  const ys = sorted.map((p) => p[1]);

  // Secant slopes
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) d[i] = (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]);

  // Initial tangent estimate (average of adjacent secants)
  const m: number[] = new Array(n);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = (d[i - 1] + d[i]) / 2;

  // Fritsch-Carlson monotonicity constraints
  for (let i = 0; i < n - 1; i++) {
    if (Math.abs(d[i]) < 1e-10) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const tau = 3 / Math.sqrt(s);
      m[i] = tau * a * d[i];
      m[i + 1] = tau * b * d[i];
    }
  }

  for (let xi = 0; xi < 256; xi++) {
    let y: number;
    if (xi <= xs[0]) {
      y = ys[0] + m[0] * (xi - xs[0]);
    } else if (xi >= xs[n - 1]) {
      y = ys[n - 1] + m[n - 1] * (xi - xs[n - 1]);
    } else {
      let seg = 0;
      for (let j = 0; j < n - 2; j++) { if (xi >= xs[j + 1]) seg = j + 1; }
      const h = xs[seg + 1] - xs[seg];
      const t = (xi - xs[seg]) / h;
      const t2 = t * t;
      const t3 = t2 * t;
      const h00 = 2 * t3 - 3 * t2 + 1;
      const h10 = t3 - 2 * t2 + t;
      const h01 = -2 * t3 + 3 * t2;
      const h11 = t3 - t2;
      y = h00 * ys[seg] + h10 * h * m[seg] + h01 * ys[seg + 1] + h11 * h * m[seg + 1];
    }
    lut[xi] = Math.max(0, Math.min(1, y / 255));
  }

  return lut;
}

// ─── Parametric → control points ─────────────────────────────────────────────
// Sliders -100…+100 shift pre-placed control points off the diagonal.

export function parametricToPoints(p: ParametricCurve): [number, number][] {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  const SCALE = 0.45; // ±100 → ±45 output units
  return [
    [0, 0],
    [64,  clamp(64  + p.shadows    * SCALE)],
    [128, clamp(128 + p.darks      * SCALE)],
    [192, clamp(192 + p.lights     * SCALE)],
    [224, clamp(224 + p.highlights * SCALE)],
    [255, 255],
  ];
}

// ─── Combined LUT texture data ────────────────────────────────────────────────
// Returns 256×4 Uint8Array for a 256×1 RGBA texture:
//   texel[x].r = composite LUT output at input x
//   texel[x].g = red LUT output
//   texel[x].b = green LUT output
//   texel[x].a = blue LUT output

function effectivePoints(curve: ToneCurve): [number, number][] {
  return curve.mode === "parametric" ? parametricToPoints(curve.parametric) : curve.points;
}

export function buildCombinedLutData(cs: CurveState): Uint8Array {
  const comp = buildCurveLUT(effectivePoints(cs.composite));
  const red  = buildCurveLUT(effectivePoints(cs.red));
  const grn  = buildCurveLUT(effectivePoints(cs.green));
  const blu  = buildCurveLUT(effectivePoints(cs.blue));
  const data = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    data[i * 4 + 0] = Math.round(comp[i] * 255);
    data[i * 4 + 1] = Math.round(red[i]  * 255);
    data[i * 4 + 2] = Math.round(grn[i]  * 255);
    data[i * 4 + 3] = Math.round(blu[i]  * 255);
  }
  return data;
}

// ─── Histogram ────────────────────────────────────────────────────────────────

export function computeHistogram(dataUrl: string): Promise<number[]> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      const { data } = ctx.getImageData(0, 0, img.width, img.height);
      const hist = new Array(256).fill(0);
      for (let i = 0; i < data.length; i += 4) {
        const lum = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
        hist[Math.max(0, Math.min(255, lum))]++;
      }
      resolve(hist);
    };
    img.onerror = () => resolve(new Array(256).fill(0));
    img.src = dataUrl;
  });
}
