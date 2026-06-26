/**
 * WebGL shader pipeline — Section 3.2 Option B of the Phase 2 TechSpec.
 *
 * Single-pass fragment shader implementing all AdjustmentState fields with the
 * exact math prescribed by the spec:
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
import type { AdjustmentState } from "@/types";

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

    // ── 12. Clarity (spec: unsharp mask at medium radius) ─────────────────
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

// ─── WebGLRenderer ───────────────────────────────────────────────────────────

export class WebGLRenderer {
  private readonly gl: WebGLRenderingContext;
  private readonly programInfo: twgl.ProgramInfo;
  private readonly bufferInfo: twgl.BufferInfo;

  private texture: WebGLTexture | null = null;
  /** Native image dimensions (pre-downsample). */
  private texW = 1;
  private texH = 1;

  /** Latest-pending adjustment state for RAF batching. */
  private pendingAdj: AdjustmentState | null = null;
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
   * Rapid calls within the same frame are batched — only the latest adj is used.
   */
  render(adj: AdjustmentState = DEFAULT_ADJ): void {
    this.pendingAdj = adj;
    if (this.rafId !== null) return; // already queued
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      if (this.pendingAdj) this._draw(this.pendingAdj);
      this.pendingAdj = null;
    });
  }

  /** Synchronous draw — use only when you need the result immediately (e.g., export). */
  drawSync(adj: AdjustmentState = DEFAULT_ADJ): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this._draw(adj);
  }

  private _draw(adj: AdjustmentState): void {
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
