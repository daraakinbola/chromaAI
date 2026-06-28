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
import type { AdjustmentState, HslAdjustments, ColorWheelState, WheelState, CurveState } from "@/types";
import { defaultHslAdjustments, defaultColorWheelState, defaultCurveState } from "@/types";
import { buildCombinedLutData } from "./curveMath";

/** One active local adjustment layer passed to the renderer each frame. */
export interface RendererLocalLayer {
  opacity: number;
  adjustments: AdjustmentState;
}

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

// Minimal pass-through shader — used by renderFromCache() to blit cached pixels
// back to the canvas without running the full adjustment pipeline.
const FS_PT = /* glsl */ `
  precision mediump float;
  varying vec2 v_uv;
  uniform sampler2D u_cache;
  void main() {
    gl_FragColor = texture2D(u_cache, v_uv);
  }
`;

const FS = /* glsl */ `
  precision highp float;
  varying vec2 v_uv;
  uniform sampler2D u_image;
  // 256×1 RGBA LUT: .r=composite .g=red .b=green .a=blue (last step in pipeline)
  uniform sampler2D u_curve_lut;

  // RAW recovery (Phase 3 Section 3)
  uniform float u_highlight_recovery; // 0.0–1.0
  uniform float u_shadow_recovery;    // 0.0–1.0

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

  // Lift / Gamma / Gain / Offset wheels — raw hue/sat/lum per zone
  // x = hue (0–360°), y = saturation (0–1), z = luminance (−1…+1)
  uniform vec3 u_lift_wheel;
  uniform vec3 u_gamma_wheel;
  uniform vec3 u_gain_wheel;
  uniform vec3 u_offset_wheel;

  // Local adjustment layers (Phase 3 PRD Section 4.5) — up to 4 layers
  // Each layer: mask texture + active flag + opacity + 10 basic adjustments
  uniform sampler2D u_mask0; uniform float u_l0_active, u_l0_opacity,
    u_l0_exp, u_l0_cont, u_l0_hl, u_l0_sh, u_l0_wh, u_l0_bl,
    u_l0_temp, u_l0_tint, u_l0_sat, u_l0_vib;
  uniform sampler2D u_mask1; uniform float u_l1_active, u_l1_opacity,
    u_l1_exp, u_l1_cont, u_l1_hl, u_l1_sh, u_l1_wh, u_l1_bl,
    u_l1_temp, u_l1_tint, u_l1_sat, u_l1_vib;
  uniform sampler2D u_mask2; uniform float u_l2_active, u_l2_opacity,
    u_l2_exp, u_l2_cont, u_l2_hl, u_l2_sh, u_l2_wh, u_l2_bl,
    u_l2_temp, u_l2_tint, u_l2_sat, u_l2_vib;
  uniform sampler2D u_mask3; uniform float u_l3_active, u_l3_opacity,
    u_l3_exp, u_l3_cont, u_l3_hl, u_l3_sh, u_l3_wh, u_l3_bl,
    u_l3_temp, u_l3_tint, u_l3_sat, u_l3_vib;

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

  // ── Local adjustment helper (basic params, no HSL/LGG/clarity) ─────────
  vec3 applyLocalAdj(vec3 rgb,
      float exp, float cont, float hl, float sh, float wh, float bl,
      float temp, float tint, float sat, float vib) {
    rgb *= pow(2.0, exp);
    rgb = clamp(rgb, 0.0, 1.0);
    float cf = cont / 100.0;
    rgb = clamp((rgb - 0.5) * (1.0 + cf) + 0.5, 0.0, 1.0);
    float lm = dot(rgb, vec3(0.299, 0.587, 0.114));
    if (abs(hl) > 0.01) { float m = smoothstep(0.4, 0.85, lm); rgb = mix(rgb, hl > 0.0 ? vec3(1.0) : vec3(0.0), abs(hl)/100.0*m); }
    if (abs(sh) > 0.01) { float m = 1.0-smoothstep(0.15, 0.6, lm); rgb = mix(rgb, sh > 0.0 ? vec3(1.0) : vec3(0.0), abs(sh)/100.0*m); }
    if (abs(wh) > 0.01) { float m = smoothstep(0.6, 1.0, lm); rgb = mix(rgb, wh > 0.0 ? vec3(1.0) : vec3(0.0), abs(wh)/100.0*m); }
    if (abs(bl) > 0.01) { float m = 1.0-smoothstep(0.0, 0.35, lm); rgb = mix(rgb, bl > 0.0 ? vec3(1.0) : vec3(0.0), abs(bl)/100.0*m); }
    float tF = clamp((temp - 5500.0) / 5000.0, -1.0, 1.0);
    rgb.r = clamp(rgb.r - tF*0.2, 0.0, 1.0);
    rgb.b = clamp(rgb.b + tF*0.2, 0.0, 1.0);
    rgb.g = clamp(rgb.g - tF*0.04, 0.0, 1.0);
    if (abs(tint) > 0.1) { rgb.g = clamp(rgb.g - (tint/150.0)*0.12, 0.0, 1.0); }
    if (abs(sat) > 0.01) { vec3 h=rgb2hsl(rgb); h.y=adjustSat(h.y,sat/100.0); rgb=hsl2rgb(h); }
    if (abs(vib) > 0.01) { vec3 h=rgb2hsl(rgb); float w=1.0-h.y*0.7; h.y=adjustSat(h.y,(vib/100.0)*w); rgb=hsl2rgb(h); }
    return clamp(rgb, 0.0, 1.0);
  }

  // ── Wheel hue/sat/lum → RGB offset (spec section 2.3) ───────────────────
  // Converts a colour-wheel position (hueDeg 0-360, sat 0-1, lum -1..+1)
  // into an additive RGB delta vector.
  //   sat=0, lum=0 → (0,0,0)  no change
  //   sat=1, lum=0 → colour direction push, max ±0.25/channel (scaled ×0.5)
  //   sat=0, lum=1 → (+0.3,+0.3,+0.3)  pure luminance lift
  vec3 hslToRgbOffset(float hueDeg, float sat, float lum) {
    vec3 baseColor = hsl2rgb(vec3(hueDeg / 360.0, sat, 0.5));
    vec3 colorOffset = (baseColor - vec3(0.5)) * 0.5;  // max ±0.25 per channel
    return colorOffset + vec3(lum * 0.3);
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

    // ── 13. Lift / Gamma / Gain / Offset (spec section 2.3) ─────────────────
    // Zone weights via smoothstep (spec-exact formula):
    //   shadowWeight    = 1 − smoothstep(0.0, 0.5, L)  peaks at L=0
    //   highlightWeight = smoothstep(0.5, 1.0, L)       peaks at L=1
    //   midtoneWeight   = 1 − shadow − highlight         peaks at L=0.5
    // Offset wheel applies equally to all zones.
    {
      float L = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
      float shadowWeight    = 1.0 - smoothstep(0.0, 0.5, L);
      float highlightWeight = smoothstep(0.5, 1.0, L);
      float midtoneWeight   = 1.0 - shadowWeight - highlightWeight;
      vec3 liftRGB   = hslToRgbOffset(u_lift_wheel.x,   u_lift_wheel.y,   u_lift_wheel.z);
      vec3 gammaRGB  = hslToRgbOffset(u_gamma_wheel.x,  u_gamma_wheel.y,  u_gamma_wheel.z);
      vec3 gainRGB   = hslToRgbOffset(u_gain_wheel.x,   u_gain_wheel.y,   u_gain_wheel.z);
      vec3 offsetRGB = hslToRgbOffset(u_offset_wheel.x, u_offset_wheel.y, u_offset_wheel.z);
      rgb += liftRGB  * shadowWeight
           + gammaRGB * midtoneWeight
           + gainRGB  * highlightWeight
           + offsetRGB;
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

    // ── 15. RAW highlight & shadow recovery ───────────────────────────────
    // Soft highlight rolloff for near-white pixels; quadratic shadow lift.
    if (u_highlight_recovery > 0.001) {
      float lum = dot(rgb, vec3(0.299, 0.587, 0.114));
      float lo = 1.0 - u_highlight_recovery * 0.45;
      if (lum > lo) {
        float t = (lum - lo) / max(1.0 - lo, 0.001);
        float newLum = lo + (1.0 - lo) * (1.0 - exp(-t * 2.0));
        rgb = rgb * (newLum / max(lum, 0.001));
      }
    }
    if (u_shadow_recovery > 0.001) {
      float lum = dot(rgb, vec3(0.299, 0.587, 0.114));
      float lift = u_shadow_recovery * 0.15 * (1.0 - lum) * (1.0 - lum);
      rgb = clamp(rgb + lift, 0.0, 1.0);
    }

    // ── 16. Tone curve (LUT — spec section 1, LAST step in pipeline) ───────
    // Composite curve applied uniformly to all channels first, then per-channel.
    {
      rgb.r = texture2D(u_curve_lut, vec2(rgb.r, 0.5)).r;
      rgb.g = texture2D(u_curve_lut, vec2(rgb.g, 0.5)).r;
      rgb.b = texture2D(u_curve_lut, vec2(rgb.b, 0.5)).r;
      float r2 = texture2D(u_curve_lut, vec2(rgb.r, 0.5)).g;
      float g2 = texture2D(u_curve_lut, vec2(rgb.g, 0.5)).b;
      float b2 = texture2D(u_curve_lut, vec2(rgb.b, 0.5)).a;
      rgb = vec3(r2, g2, b2);
    }

    // ── 17. Local adjustment layers (Phase 3 PRD Section 4.5) ────────────────
    // Applied after tone curve; mask UV = image UV (same coordinate system).
    if (u_l0_active > 0.5) {
      float mv = texture2D(u_mask0, uv).r * u_l0_opacity;
      if (mv > 0.001) { rgb = mix(rgb, applyLocalAdj(rgb,u_l0_exp,u_l0_cont,u_l0_hl,u_l0_sh,u_l0_wh,u_l0_bl,u_l0_temp,u_l0_tint,u_l0_sat,u_l0_vib), mv); }
    }
    if (u_l1_active > 0.5) {
      float mv = texture2D(u_mask1, uv).r * u_l1_opacity;
      if (mv > 0.001) { rgb = mix(rgb, applyLocalAdj(rgb,u_l1_exp,u_l1_cont,u_l1_hl,u_l1_sh,u_l1_wh,u_l1_bl,u_l1_temp,u_l1_tint,u_l1_sat,u_l1_vib), mv); }
    }
    if (u_l2_active > 0.5) {
      float mv = texture2D(u_mask2, uv).r * u_l2_opacity;
      if (mv > 0.001) { rgb = mix(rgb, applyLocalAdj(rgb,u_l2_exp,u_l2_cont,u_l2_hl,u_l2_sh,u_l2_wh,u_l2_bl,u_l2_temp,u_l2_tint,u_l2_sat,u_l2_vib), mv); }
    }
    if (u_l3_active > 0.5) {
      float mv = texture2D(u_mask3, uv).r * u_l3_opacity;
      if (mv > 0.001) { rgb = mix(rgb, applyLocalAdj(rgb,u_l3_exp,u_l3_cont,u_l3_hl,u_l3_sh,u_l3_wh,u_l3_bl,u_l3_temp,u_l3_tint,u_l3_sat,u_l3_vib), mv); }
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

/** Flatten a WheelState to the [hue, saturation, luminance] vec3 expected by the shader. */
function wheelVec3(w: WheelState): [number, number, number] {
  return [w.hue, w.saturation, w.luminance];
}

// ─── WebGLRenderer ───────────────────────────────────────────────────────────

export class WebGLRenderer {
  private readonly gl: WebGLRenderingContext;
  private readonly programInfo: twgl.ProgramInfo;
  private readonly passthroughProgramInfo: twgl.ProgramInfo;
  private readonly bufferInfo: twgl.BufferInfo;

  private texture: WebGLTexture | null = null;
  /** Native image dimensions (pre-downsample). */
  private texW = 1;
  private texH = 1;

  /** Tone curve LUT texture — 256×1 RGBA. Updated lazily when curveState changes. */
  private curveLutTexture: WebGLTexture | null = null;
  private lastCurveState: CurveState | null = null;

  /** Local adjustment layer mask textures (up to 4 slots). */
  private maskTextures: (WebGLTexture | null)[] = [null, null, null, null];
  /** Fallback 1×1 black texture used for inactive mask slots. */
  private emptyMaskTexture!: WebGLTexture;

  /** Latest-pending state for RAF batching. */
  private pendingAdj: AdjustmentState | null = null;
  private pendingHsl: HslAdjustments = defaultHslAdjustments;
  private pendingWheels: ColorWheelState = defaultColorWheelState;
  private pendingCurves: CurveState = defaultCurveState;
  private pendingHighlightRecovery = 0;
  private pendingShadowRecovery = 0;
  private pendingLocalLayers: RendererLocalLayer[] = [];
  private pendingOnRendered: (() => void) | null = null;
  private rafId: number | null = null;

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl", { preserveDrawingBuffer: true, antialias: false });
    if (!gl) throw new Error("WebGL not available");
    this.gl = gl;
    this.programInfo = twgl.createProgramInfo(gl, [VS, FS]);
    this.passthroughProgramInfo = twgl.createProgramInfo(gl, [VS, FS_PT]);
    // Two triangles covering the full clip-space quad
    this.bufferInfo = twgl.createBufferInfoFromArrays(gl, {
      a_position: { data: [-1, -1, 1, -1, -1, 1,  -1, 1, 1, -1, 1, 1], numComponents: 2 },
    });
    this._initCurveLut();
    this._initEmptyMaskTexture();
  }

  private _initEmptyMaskTexture(): void {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, 1, 1, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, new Uint8Array([0]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.emptyMaskTexture = tex;
  }

  /**
   * Upload (or replace) the grayscale mask for a local adjustment layer slot (0-3).
   * Pass null maskData to clear the slot (deactivate).
   */
  updateMaskLayer(index: number, maskData: Uint8ClampedArray | null, width: number, height: number): void {
    if (index < 0 || index >= 4) return;
    const gl = this.gl;
    if (!maskData) {
      if (this.maskTextures[index]) {
        gl.deleteTexture(this.maskTextures[index]);
        this.maskTextures[index] = null;
      }
      return;
    }
    if (!this.maskTextures[index]) {
      this.maskTextures[index] = gl.createTexture();
    }
    gl.bindTexture(gl.TEXTURE_2D, this.maskTextures[index]);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, width, height, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, maskData);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  private _initCurveLut(): void {
    const gl = this.gl;
    const data = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i++) { data[i*4]=i; data[i*4+1]=i; data[i*4+2]=i; data[i*4+3]=i; }
    this.curveLutTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.curveLutTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  private _updateCurveLut(curveState: CurveState): void {
    if (curveState === this.lastCurveState) return;
    this.lastCurveState = curveState;
    const gl = this.gl;
    const data = buildCombinedLutData(curveState);
    gl.bindTexture(gl.TEXTURE_2D, this.curveLutTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
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
   * `onRendered` fires after the draw completes; if batching skipped an earlier call,
   * only the winning call's callback fires (latest-wins semantics).
   */
  render(
    adj: AdjustmentState = DEFAULT_ADJ,
    hsl: HslAdjustments = defaultHslAdjustments,
    colorWheels: ColorWheelState = defaultColorWheelState,
    curveState: CurveState = defaultCurveState,
    highlightRecovery = 0,
    shadowRecovery = 0,
    localLayers: RendererLocalLayer[] = [],
    onRendered?: () => void,
  ): void {
    this.pendingAdj = adj;
    this.pendingHsl = hsl;
    this.pendingWheels = colorWheels;
    this.pendingCurves = curveState;
    this.pendingHighlightRecovery = highlightRecovery;
    this.pendingShadowRecovery = shadowRecovery;
    this.pendingLocalLayers = localLayers;
    this.pendingOnRendered = onRendered ?? null; // latest callback wins
    if (this.rafId !== null) return; // already queued; new state will be used when it fires
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      if (this.pendingAdj) this._draw(
        this.pendingAdj, this.pendingHsl, this.pendingWheels, this.pendingCurves,
        this.pendingHighlightRecovery, this.pendingShadowRecovery, this.pendingLocalLayers,
      );
      this.pendingAdj = null;
      const cb = this.pendingOnRendered;
      this.pendingOnRendered = null;
      cb?.();
    });
  }

  /** Cancel any queued RAF render without drawing. */
  cancelPending(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
      this.pendingAdj = null;
      this.pendingOnRendered = null;
    }
  }

  /**
   * Blit previously captured pixel data back to the canvas via a minimal
   * pass-through shader, bypassing the entire adjustment pipeline.
   * Called on render-cache hits (PRD Section 5.4).
   */
  renderFromCache(pixels: Uint8Array, srcWidth: number, srcHeight: number): void {
    const gl = this.gl;
    const canvas = gl.canvas as HTMLCanvasElement;
    const cw = canvas.width, ch = canvas.height;
    if (!cw || !ch) return;

    gl.viewport(0, 0, cw, ch);

    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA, srcWidth, srcHeight, 0,
      gl.RGBA, gl.UNSIGNED_BYTE, pixels,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    gl.useProgram(this.passthroughProgramInfo.program);
    twgl.setBuffersAndAttributes(gl, this.passthroughProgramInfo, this.bufferInfo);
    twgl.setUniforms(this.passthroughProgramInfo, { u_cache: tex });
    twgl.drawBufferInfo(gl, this.bufferInfo);

    gl.deleteTexture(tex);
  }

  /**
   * Synchronously read back the current framebuffer pixels.
   * Called immediately after drawSync() / _draw() to populate the render cache.
   * Returns null if the canvas has no valid dimensions.
   */
  capturePixels(): { data: Uint8Array; width: number; height: number } | null {
    const gl = this.gl;
    const canvas = gl.canvas as HTMLCanvasElement;
    const w = canvas.width, h = canvas.height;
    if (!w || !h) return null;
    const data = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, data);
    return { data, width: w, height: h };
  }

  /** Synchronous draw — use only when you need the result immediately (e.g., export). */
  drawSync(
    adj: AdjustmentState = DEFAULT_ADJ,
    hsl: HslAdjustments = defaultHslAdjustments,
    colorWheels: ColorWheelState = defaultColorWheelState,
    curveState: CurveState = defaultCurveState,
    highlightRecovery = 0,
    shadowRecovery = 0,
    localLayers: RendererLocalLayer[] = [],
  ): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this._draw(adj, hsl, colorWheels, curveState, highlightRecovery, shadowRecovery, localLayers);
  }

  private _draw(
    adj: AdjustmentState, hsl: HslAdjustments, colorWheels: ColorWheelState,
    curveState: CurveState, highlightRecovery = 0, shadowRecovery = 0,
    localLayers: RendererLocalLayer[] = [],
  ): void {
    const gl = this.gl;
    if (!this.texture) return;

    const canvas = gl.canvas as HTMLCanvasElement;
    const cw = canvas.width;
    const ch = canvas.height;
    if (!cw || !ch) return;

    gl.viewport(0, 0, cw, ch);
    gl.clearColor(0.039, 0.039, 0.039, 1); // zinc-950
    gl.clear(gl.COLOR_BUFFER_BIT);

    this._updateCurveLut(curveState);

    gl.useProgram(this.programInfo.program);
    twgl.setBuffersAndAttributes(gl, this.programInfo, this.bufferInfo);
    // Build local layer uniform block
    const llUniforms: Record<string, unknown> = {};
    for (let i = 0; i < 4; i++) {
      const ll = localLayers[i];
      const p = `u_l${i}`;
      const maskTex = this.maskTextures[i] ?? this.emptyMaskTexture;
      const adj2 = ll?.adjustments ?? DEFAULT_ADJ;
      llUniforms[`u_mask${i}`]   = maskTex;
      llUniforms[`${p}_active`]  = (ll && ll.opacity > 0 && this.maskTextures[i]) ? 1 : 0;
      llUniforms[`${p}_opacity`] = ll?.opacity ?? 0;
      llUniforms[`${p}_exp`]     = adj2.exposure;
      llUniforms[`${p}_cont`]    = adj2.contrast;
      llUniforms[`${p}_hl`]      = adj2.highlights;
      llUniforms[`${p}_sh`]      = adj2.shadows;
      llUniforms[`${p}_wh`]      = adj2.whites;
      llUniforms[`${p}_bl`]      = adj2.blacks;
      llUniforms[`${p}_temp`]    = adj2.temperature;
      llUniforms[`${p}_tint`]    = adj2.tint;
      llUniforms[`${p}_sat`]     = adj2.saturation;
      llUniforms[`${p}_vib`]     = adj2.vibrance;
    }

    twgl.setUniforms(this.programInfo, {
      u_image:        this.texture,
      u_curve_lut:    this.curveLutTexture,
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
      u_lift_wheel:          wheelVec3(colorWheels.lift),
      u_gamma_wheel:         wheelVec3(colorWheels.gamma),
      u_gain_wheel:          wheelVec3(colorWheels.gain),
      u_offset_wheel:        wheelVec3(colorWheels.offset),
      u_highlight_recovery:  highlightRecovery / 100,
      u_shadow_recovery:     shadowRecovery / 100,
      ...llUniforms,
    });
    twgl.drawBufferInfo(gl, this.bufferInfo);
  }

  /** Free GPU resources. */
  destroy(): void {
    if (this.rafId !== null) { cancelAnimationFrame(this.rafId); this.rafId = null; }
    if (this.texture) { this.gl.deleteTexture(this.texture); this.texture = null; }
    if (this.curveLutTexture) { this.gl.deleteTexture(this.curveLutTexture); this.curveLutTexture = null; }
    if (this.emptyMaskTexture) { this.gl.deleteTexture(this.emptyMaskTexture); }
    for (let i = 0; i < 4; i++) {
      if (this.maskTextures[i]) { this.gl.deleteTexture(this.maskTextures[i]); this.maskTextures[i] = null; }
    }
    this.gl.deleteProgram(this.passthroughProgramInfo.program);
  }
}

/** Returns true if the browser supports WebGL. */
export function webglSupported(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!c.getContext("webgl");
  } catch { return false; }
}

/**
 * PRD §5.5 acceptance criterion: detects WebGPU availability and emits a
 * console warning so developers know ChromaAI is using WebGL instead.
 * No error is thrown and no UI is affected — the fallback to WebGL is silent.
 * Call once on workspace mount.
 */
export function detectWebGPU(): void {
  if (typeof navigator !== "undefined" && "gpu" in navigator) {
    console.warn(
      "[ChromaAI] WebGPU is available in this browser but ChromaAI currently " +
      "uses WebGL 1 for all rendering. WebGPU acceleration (PRD §5.1, ~6× faster " +
      "for 24MP images) is planned for a future release. No action needed."
    );
  }
}
