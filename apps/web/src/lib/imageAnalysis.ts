export interface ImageStats {
  luminance: number;        // average luminance 0–1
  colorTemperature: number; // estimated Kelvin
}

export function analyzeImageStats(dataUrl: string): Promise<ImageStats> {
  return new Promise((resolve) => {
    const img = new Image();

    img.onerror = () => resolve({ luminance: 0.5, colorTemperature: 5500 });

    img.onload = () => {
      const SIZE = 200;
      const scale = Math.min(SIZE / img.width, SIZE / img.height, 1);
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));

      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return resolve({ luminance: 0.5, colorTemperature: 5500 });

      ctx.drawImage(img, 0, 0, w, h);
      const { data } = ctx.getImageData(0, 0, w, h);

      let sumL = 0, sumR = 0, sumB = 0;
      const n = w * h;

      for (let i = 0; i < data.length; i += 4) {
        const r = data[i] / 255;
        const g = data[i + 1] / 255;
        const b = data[i + 2] / 255;
        sumL += 0.299 * r + 0.587 * g + 0.114 * b;
        sumR += r;
        sumB += b;
      }

      const luminance = sumL / n;
      const avgR = sumR / n;
      const avgB = sumB / n;

      // Estimate color temperature from R/B channel ratio.
      // Warm (high R/B) → low K; cool (low R/B) → high K.
      // Calibrated so R/B ≈ 1.0 → 5500K, ≈ 1.5 → ~3700K, ≈ 0.7 → ~8000K
      const rb = avgB > 0.001 ? avgR / avgB : 1.0;
      const colorTemperature = Math.round(Math.max(2000, Math.min(50000, 5500 / rb)));

      resolve({ luminance, colorTemperature });
    };

    img.src = dataUrl;
  });
}
