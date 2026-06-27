/**
 * WebGL shader pipeline — Section 3.2 Option B of the Phase 2 TechSpec.
 *
 * Single-pass fragment shader implementing all AdjustmentState fields plus
 * per-channel HSL (8 hue bands) with the exact math prescribed by the spec:
 *   Exposure    pow(2, value)
 *   Contrast    S-curve centred at 0.5
 *   Highlights  smoothstep mask on luminous regions
 *   Shadows     smoothstep mask on dark regions
 *   Whites      white-point expansion via luminance mask
 *   Blacks      black-point expansion via luminance mask
 *   Temperature R/B channel shift using normalised Kelvin offset
 *   Tint        green-magenta axis shift
 *   Saturation  RGB → HSL → multiply S → HSL → RGB
 *   Vibrance    like Saturation, scaled by (1 − S) to spare saturated pixels
 *   HSL         per-hue-band hue/saturation/luminance (8 bands, triangular weights)
 *   Clarity     unsharp mask at medium radius via 5-tap cross blur
 *
 * Contain-fit letterboxing is handled in the shader so the canvas can fill its
 * CSS container without distorting the image.
 *
 * Performance (spec Section 3.3):
 *   render() schedules a single RAF per call-burst (debounce ≤ 1 frame = 8ms).
 *   For images > 24 MP the canvas resolution is capped at 4K equivalent.
 */

import * as twgl from "twgl.js";
import type { AdjustmentState, HslAdjustments, ColorWheelState, WheelState } from "@/types";
import { defaultHslAdjustments, defaultColorWheelState } from "@/types";

// ─── Shaders ─────────────────────────────────────────────────────────────────

const VS = /* glsl */ `
  attribute vec2 a_position;
  varying vec2 v_uv;
  void main() {
    gl_Position = vec4(a_position, 0.0, 1.0);
    // NDC (-1..1) → UV (0..1), flip Y so (0,0) is top-left
    v_uv = vec2(a_position.x * 0.5 + 0.5, 0.5 - a_position.y * 0.5);
  }
`;

const FS = /* glsl */ `
  precision highp float;
  varying vec2 v_uv;
  uniform sampler2D u_image;

  // Contain-fit geometry
  uniform float u_imageAspect;   // imageW / imageH
  uniform float u_canvasAspect;  // canvas.width / canvas.height

  // Adjustments
  uniform float u_exposure;      // stops  −5 … +5
  uniform float u_contrast;      // −100 … +100
  uniform float u_highlights;    // −100 … +100
  uniform float u_shadows;       // −100 … +100
  uniform float u_whites;        // −100 … +100
  uniform float u_blacks;        // −100 … +100
  uniform float u_clarity;       // −100 … +100
  uniform float u_vibrance;      // −100 … +100
  uniform float u_saturation;    // −100 … +100
  uniform float u_temperature;   // Kelvin  2000 … 50000
  uniform float u_tint;          // −150 … +150
  uniform vec2  u_texelSize;     // 1/texW, 1/texH  (for clarity blur)

  // Per-channel HSL: 8 bands (Red, Orange, Yellow, Green, Aqua, Blue, Purple, Magenta)
  // Each vec3 = (hue_shift, sat_delta, lum_delta) all normalised to −1..+1
  uniform vec3 u_hsl[8];

  // Lift / Gamma / Gain — zone-weighted colour offsets (pre-computed in JS)
  // u_*_color: RGB delta centred at 0 (computed from wheel hue+saturation)
  // u_*_lum:   scalar luminance delta
  uniform vec3  u_lift_color;
  uniform vec3  u_gamma_color;
  uniform vec3  u_gain_color;
  uniform float u_lift_lum;
  uniform float u_gamma_lum;
  uniform float u_gain_lum;

  // ── RGB ↔ HSL ─────────────────────────────────────────────────────────────
  vec3 rgb2hsl(vec3 c) {
    float maxC = max(c.r, max(c.g, c.b));
    float minC = min(c.r, min(c.g, c.b));
    float delta = maxC - minC;
    float l = (maxC + minC) * 0.5;
    float h = 0.0, s = 0.0;
    if (delta > 1e-5) {
      s = delta / (1.0 - abs(2.0 * l - 1.0));
      if      (maxC == c.r) { h = (c.g - c.b) / delta; if (h < 0.0) h += 6.0; }
      else if (maxC == c.g) { h = (c.b - c.r) / delta + 2.0; }
      else                  { h = (c.r - c.g) / delta + 4.0; }
      h /= 6.0;
    }
    return vec3(h, s, l);
  }

  float _h2r(float p, float q, float t) {
    if (t < 0.0) t += 1.0;
    if (t > 1.0) t -= 1.0;
    if (t < 1.0/6.0) return p + (q - p) * 6.0 * t;
    if (t < 0.5)     return q;
    if (t < 2.0/3.0) return p + (q - p) * (2.0/3.0 - t) * 6.0;
    return p;
  }

  vec3 hsl2rgb(vec3 hsl) {
    if (hsl.y < 1e-5) return vec3(hsl.z);
    float q = hsl.z < 0.5 ? hsl.z * (1.0 + hsl.y) : hsl.z + hsl.y - hsl.z * hsl.y;
    float p = 2.0 * hsl.z - q;
    return vec3(_h2r(p, q, hsl.x + 1.0/3.0), _h2r(p, q, hsl.x), _h2r(p, q, hsl.x - 1.0/3.0));
  }

  // ── Adjust a single HSL saturation channel by factor (−1..+1) ─────────────
  float adjustSat(float s, float f) {
    return f > 0.0 ? clamp(s + f * (1.0 - s), 0.0, 1.0)
                   : clamp(s + f * s,           0.0, 1.0);
  }

  void main() {
    // ── 1. Contain-fit UV mapping ──────────────────────────────────────────
    vec2 uv = v_uv;
    if (u_imageAspect > u_canvasAspect) {
      // Letterbox: bars top + bottom; image fills full width
      float topMargin = (1.0 - u_canvasAspect / u_imageAspect) * 0.5;
      uv.y = (v_uv.y - topMargin) * (u_imageAspect / u_canvasAspect);
    } else {
      // Pillarbox: bars left + right; image fills full height
      float leftMargin = (1.0 - u_imageAspect / u_canvasAspect) * 0.5;
      uv.x = (v_uv.x - leftMargin) * (u_canvasAspect / u_imageAspect);
    }

    // Background colour (zinc-950) for letterbox / pillarbox bars
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
      gl_FragColor = vec4(0.039, 0.039, 0.039, 1.0);
      return;
    }

    vec3 rgb = texture2D(u_image, uv).rgb;

    // ── 2. Exposure (spec: multiply by pow(2, stops)) ─────────────────────
    rgb *= pow(2.0, u_exposure);
    rgb = clamp(rgb, 0.0, 1.0);

    // ── 3. Contrast (S-curve centred at 0.5) ──────────────────────────────
    float cf = u_contrast / 100.0;
    rgb = clamp((rgb - 0.5) * (1.0 + cf) + 0.5, 0.0, 1.0);

    // Luminance used for range-based controls (computed after global ops)
    float lum = dot(rgb, vec3(0.299, 0.587, 0.114));

    // ── 4. Highlights (spec: reduce values above 0.5) ─────────────────────
    if (abs(u_highlights) > 0.01) {
      float mask = smoothstep(0.4, 0.85, lum);
      float f    = u_highlights / 100.0;
      vec3 tgt   = f > 0.0 ? vec3(1.0) : vec3(0.0);
      rgb = mix(rgb, tgt, abs(f) * mask);
    }

    // ── 5. Shadows (spec: increase values below 0.5) ──────────────────────
    if (abs(u_shadows) > 0.01) {
      float mask = 1.0 - smoothstep(0.15, 0.6, lum);
      float f    = u_shadows / 100.0;
      vec3 tgt   = f > 0.0 ? vec3(1.0) : vec3(0.0);
      rgb = mix(rgb, tgt, abs(f) * mask);
    }

    // ── 6. Whites (spec: clip/expand the white point) ─────────────────────
    if (abs(u_whites) > 0.01) {
      float mask = smoothstep(0.6, 1.0, lum);
      float f    = u_whites / 100.0;
      vec3 tgt   = f > 0.0 ? vec3(1.0) : vec3(0.0);
      rgb = mix(rgb, tgt, abs(f) * mask);
    }

    // ── 7. Blacks (spec: clip/expand the black point) ─────────────────────
    if (abs(u_blacks) > 0.01) {
      float mask = 1.0 - smoothstep(0.0, 0.35, lum);
      float f    = u_blacks / 100.0;
      vec3 tgt   = f > 0.0 ? vec3(1.0) : vec3(0.0);
      rgb = mix(rgb, tgt, abs(f) * mask);
    }

    // ── 8. Temperature (spec: shift R and B in opposite directions) ────────
    // Kelvin-to-RGB: warm (low K) → more R, less B; cool (high K) → more B, less R
    float tempF = clamp((u_temperature - 5500.0) / 5000.0, -1.0, 1.0);
    rgb.r = clamp(rgb.r - tempF * 0.2, 0.0, 1.0);
    rgb.b = clamp(rgb.b + tempF * 0.2, 0.0, 1.0);
    // Slight green compensation (teal-orange balance)
    rgb.g = clamp(rgb.g - tempF * 0.04, 0.0, 1.0);

    // ── 9. Tint (green-magenta axis) ──────────────────────────────────────
    if (abs(u_tint) > 0.1) {
      float tf = u_tint / 150.0;  // −1..+1
      rgb.g = clamp(rgb.g - tf * 0.12, 0.0, 1.0);
    }

    // ── 10. Saturation (spec: convert to HSL, multiply S, convert back) ───
    if (abs(u_saturation) > 0.01) {
      vec3 hsl = rgb2hsl(rgb);
      hsl.y = adjustSat(hsl.y, u_saturation / 100.0);
      rgb = hsl2rgb(hsl);
    }

    // ── 11. Vibrance (spec: like saturation, reduced on already-sat pixels) ─
    if (abs(u_vibrance) > 0.01) {
      vec3 hsl = rgb2hsl(rgb);
      float vibF   = u_vibrance / 100.0;
      float weight = 1.0 - hsl.y * 0.7;  // spares saturated pixels
      hsl.y = adjustSat(hsl.y, vibF * weight);
      rgb = hsl2rgb(hsl);
    }

    // ── 12. Per-channel HSL (8 hue bands) ─────────────────────────────────
    // Band centres (0-1 hue): Red=0, Orange=1/12, Yellow=1/6, Green=1/3,
    //   Aqua=1/2, Blue=2/3, Purple=3/4, Magenta=11/12.
    // Triangular falloff with half-width HW ≈ 30° so adjacent bands overlap.
    // u_hsl[i].xyz = (hue_shift, sat_delta, lum_delta) each −1..+1.
    //   hue: ±1 → ±180° (±0.5 in 0-1 space).
    //   sat/lum: proportional push toward 1 (positive) or 0 (negative).
    {
      vec3 px = rgb2hsl(rgb);
      if (px.y > 0.02) {    // skip nearly-grey pixels — hue is undefined there
        float h  = px.x;
        float HW = 0.0833;  // ~30° half-width
        // Circular hue distances
        float d0 = min(abs(h-0.0000), 1.0-abs(h-0.0000));
        float d1 = min(abs(h-0.0833), 1.0-abs(h-0.0833));
        float d2 = min(abs(h-0.1667), 1.0-abs(h-0.1667));
        float d3 = min(abs(h-0.3333), 1.0-abs(h-0.3333));
        float d4 = min(abs(h-0.5000), 1.0-abs(h-0.5000));
        float d5 = min(abs(h-0.6667), 1.0-abs(h-0.6667));
        float d6 = min(abs(h-0.7500), 1.0-abs(h-0.7500));
        float d7 = min(abs(h-0.9167), 1.0-abs(h-0.9167));
        // Triangular band weights
        float w0 = max(0.0, 1.0-d0/HW);
        float w1 = max(0.0, 1.0-d1/HW);
        float w2 = max(0.0, 1.0-d2/HW);
        float w3 = max(0.0, 1.0-d3/HW);
        float w4 = max(0.0, 1.0-d4/HW);
        float w5 = max(0.0, 1.0-d5/HW);
        float w6 = max(0.0, 1.0-d6/HW);
        float w7 = max(0.0, 1.0-d7/HW);
        // Weighted sum of per-band deltas
        float dH = w0*u_hsl[0].x+w1*u_hsl[1].x+w2*u_hsl[2].x+w3*u_hsl[3].x
                  +w4*u_hsl[4].x+w5*u_hsl[5].x+w6*u_hsl[6].x+w7*u_hsl[7].x;
        float dS = w0*u_hsl[0].y+w1*u_hsl[1].y+w2*u_hsl[2].y+w3*u_hsl[3].y
                  +w4*u_hsl[4].y+w5*u_hsl[5].y+w6*u_hsl[6].y+w7*u_hsl[7].y;
        float dL = w0*u_hsl[0].z+w1*u_hsl[1].z+w2*u_hsl[2].z+w3*u_hsl[3].z
                  +w4*u_hsl[4].z+w5*u_hsl[5].z+w6*u_hsl[6].z+w7*u_hsl[7].z;
        // Apply: hue ±180°; sat/lum proportional push toward 0 or 1
        px.x = fract(px.x + dH * 0.5);
        px.y = clamp(dS >= 0.0 ? px.y+dS*(1.0-px.y) : px.y+dS*px.y, 0.0, 1.0);
        px.z = clamp(dL >= 0.0 ? px.z+dL*(1.0-px.z) : px.z+dL*px.z, 0.0, 1.0);
        rgb = hsl2rgb(px);
      }
    }

    // ── 13. Lift / Gamma / Gain (zone-weighted additive blending) ─────────
    // Quadratic zone weights of Rec.709 luminance L:
    //   lift  (1−L)²   peaks at L=0 (shadows)
    //   gamma 4L(1−L)  peaks at L=0.5 (midtones, max weight = 1)
    //   gain  L²       peaks at L=1 (highlights)
    // JS pre-scales u_*_color by 0.5 (max ±0.25 per channel at full sat)
    // and u_*_lum by 0.3 for comfortable range.
    {
      float lggL = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
      float wL = (1.0 - lggL) * (1.0 - lggL);
      float wM = 4.0 * lggL * (1.0 - lggL);
      float wH = lggL * lggL;
      rgb += u_lift_color  * wL + u_gamma_color * wM + u_gain_color * wH;
      rgb += vec3(u_lift_lum * wL + u_gamma_lum * wM + u_gain_lum * wH);
      rgb  = clamp(rgb, 0.0, 1.0);
    }

    // ── 14. Clarity (spec: unsharp mask at medium radius) ─────────────────
    if (abs(u_clarity) > 0.01) {
      // 5-tap cross blur at medium radius (~20 image-space pixels)
      float R = 20.0;
      vec3 blurred =
        texture2D(u_image, uv).rgb                                           * 0.40 +
        texture2D(u_image, uv + vec2( R, 0.0) * u_texelSize).rgb            * 0.15 +
        texture2D(u_image, uv + vec2(-R, 0.0) * u_texelSize).rgb            * 0.15 +
        texture2D(u_image, uv + vec2(0.0,  R) * u_texelSize).rgb            * 0.15 +
        texture2D(u_image, uv + vec2(0.0, -R) * u_texelSize).rgb            * 0.15;

      float clarityF = u_clarity / 100.0;
      if (clarityF >= 0.0) {
        // Sharpen: add local contrast detail
        float localContrast = dot(rgb - blurred, vec3(0.299, 0.587, 0.114));
        rgb = clamp(rgb + localContrast * clarityF * 2.5, 0.0, 1.0);
      } else {
        // Negative clarity → diffusion / glow
        rgb = mix(rgb, blurred, -clarityF);
      }
    }

    gl_FragColor = vec4(clamp(rgb, 0.0, 1.0), 1.0);
  }
`;

// ─── Constants ───────────────────────────────────────────────────────────────

/** Images above this pixel count are downsampled to this for the real-time canvas. */
const MAX_CANVAS_PIXELS = 3840 * 2160; // 4 K equivalent

const DEFAULT_ADJ: AdjustmentState = {
  exposure: 0, contrast: 0, highlights: 0, shadows: 0,
  whites: 0, blacks: 0, clarity: 0, vibrance: 0, saturation: 0,
  temperature: 5500, tint: 0,
};

const HSL_CHANNEL_ORDER: (keyof HslAdjustments)[] = [
  "red", "orange", "yellow", "green", "aqua", "blue", "purple", "magenta",
];

function flattenHsl(hsl: HslAdjustments): number[] {
  return HSL_CHANNEL_ORDER.flatMap((k) => [
    hsl[k].hue        / 100,
    hsl[k].saturation / 100,
    hsl[k].luminance  / 100,
  ]);
}

// ─── Lift / Gamma / Gain helpers ─────────────────────────────────────────────

function _h2r(p: number, q: number, t: number): number {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 0.5)   return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

function hsl01ToRgb(h01: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [_h2r(p, q, h01 + 1 / 3), _h2r(p, q, h01), _h2r(p, q, h01 - 1 / 3)];
}

/** Convert a WheelState to the uniform values passed to the shader. */
function wheelUniforms(w: WheelState): { color: [number, number, number]; lum: number } {
  const [r, g, b] = hsl01ToRgb(w.hue / 360, w.saturation, 0.5);
  // Offset from neutral (0.5, 0.5, 0.5).
  // Scale by 0.5 → max ±0.25 per channel at saturation=1.
  return {
    color: [(r - 0.5) * 0.5, (g - 0.5) * 0.5, (b - 0.5) * 0.5],
    lum: w.luminance * 0.3,
  };
}

// ─── WebGLRenderer ───────────────────────────────────────────────────────────

export class WebGLRenderer {
  private readonly gl: WebGLRenderingContext;
  private readonly programInfo: twgl.ProgramInfo;
  private readonly bufferInfo: twgl.BufferInfo;

  private texture: WebGLTexture | null = null;
  /** Native image dimensions (pre-downsample). */
  private texW = 1;
  private texH = 1;

  /** Latest-pending state for RAF batching. */
  private pendingAdj: AdjustmentState | null = null;
  private pendingHsl: HslAdjustments = defaultHslAdjustments;
  private pendingWheels: ColorWheelState = defaultColorWheelState;
  private rafId: number | null = null;

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl", { preserveDrawingBuffer: true, antialias: false });
    if (!gl) throw new Error("WebGL not available");
    this.gl = gl;
    this.programInfo = twgl.createProgramInfo(gl, [VS, FS]);
    // Two triangles covering the full clip-space quad
    this.bufferInfo = twgl.createBufferInfoFromArrays(gl, {
      a_position: { data: [-1, -1, 1, -1, -1, 1,  -1, 1, 1, -1, 1, 1], numComponents: 2 },
    });
  }

  /**
   * Load an image into the WebGL texture.
   * Returns the recommended canvas pixel dimensions (capped at 4 K for >24 MP).
   */
  loadImage(src: string): Promise<{ width: number; height: number }> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        const gl = this.gl;
        this.texW = img.naturalWidth;
        this.texH = img.naturalHeight;

        if (this.texture) gl.deleteTexture(this.texture);
        this.texture = twgl.createTexture(gl, {
          src: img,
          min: gl.LINEAR,
          mag: gl.LINEAR,
          wrap: gl.CLAMP_TO_EDGE,
        });

        // Recommended canvas resolution (spec: cap at 4 K for >24 MP images)
        let w = this.texW, h = this.texH;
        if (w * h > MAX_CANVAS_PIXELS) {
          const scale = Math.sqrt(MAX_CANVAS_PIXELS / (w * h));
          w = Math.round(w * scale);
          h = Math.round(h * scale);
        }
        resolve({ width: w, height: h });
      };
      img.onerror = () => reject(new Error(`Failed to load image: ${src.slice(0, 60)}`));
      img.src = src;
    });
  }

  /**
   * Schedule a render for the next animation frame (spec: ≤ 8 ms debounce).
   * Rapid calls within the same frame are batched — only the latest state is used.
   */
  render(
    adj: AdjustmentState = DEFAULT_ADJ,
    hsl: HslAdjustments = defaultHslAdjustments,
    colorWheels: ColorWheelState = defaultColorWheelState
  ): void {
    this.pendingAdj = adj;
    this.pendingHsl = hsl;
    this.pendingWheels = colorWheels;
    if (this.rafId !== null) return; // already queued
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      if (this.pendingAdj) this._draw(this.pendingAdj, this.pendingHsl, this.pendingWheels);
      this.pendingAdj = null;
    });
  }

  /** Synchronous draw — use only when you need the result immediately (e.g., export). */
  drawSync(
    adj: AdjustmentState = DEFAULT_ADJ,
    hsl: HslAdjustments = defaultHslAdjustments,
    colorWheels: ColorWheelState = defaultColorWheelState
  ): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this._draw(adj, hsl, colorWheels);
  }

  private _draw(adj: AdjustmentState, hsl: HslAdjustments, colorWheels: ColorWheelState): void {
    const gl = this.gl;
    if (!this.texture) return;

    const canvas = gl.canvas as HTMLCanvasElement;
    const cw = canvas.width;
    const ch = canvas.height;
    if (!cw || !ch) return;

    gl.viewport(0, 0, cw, ch);
    gl.clearColor(0.039, 0.039, 0.039, 1); // zinc-950
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(this.programInfo.program);
    twgl.setBuffersAndAttributes(gl, this.programInfo, this.bufferInfo);
    const lift  = wheelUniforms(colorWheels.lift);
    const gamma = wheelUniforms(colorWheels.gamma);
    const gain  = wheelUniforms(colorWheels.gain);

    twgl.setUniforms(this.programInfo, {
      u_image:        this.texture,
      u_texelSize:    [1 / this.texW, 1 / this.texH],
      u_imageAspect:  this.texW / this.texH,
      u_canvasAspect: cw / ch,
      u_exposure:     adj.exposure,
      u_contrast:     adj.contrast,
      u_highlights:   adj.highlights,
      u_shadows:      adj.shadows,
      u_whites:       adj.whites,
      u_blacks:       adj.blacks,
      u_clarity:      adj.clarity,
      u_vibrance:     adj.vibrance,
      u_saturation:   adj.saturation,
      u_temperature:  adj.temperature,
      u_tint:         adj.tint,
      u_hsl:          flattenHsl(hsl),
      u_lift_color:   lift.color,
      u_gamma_color:  gamma.color,
      u_gain_color:   gain.color,
      u_lift_lum:     lift.lum,
      u_gamma_lum:    gamma.lum,
      u_gain_lum:     gain.lum,
    });
    twgl.drawBufferInfo(gl, this.bufferInfo);
  }

  /** Free GPU resources. */
  destroy(): void {
    if (this.rafId !== null) { cancelAnimationFrame(this.rafId); this.rafId = null; }
    if (this.texture) { this.gl.deleteTexture(this.texture); this.texture = null; }
  }
}

/** Returns true if the browser supports WebGL. */
export function webglSupported(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!c.getContext("webgl");
  } catch { return false; }
}
