import type {
  BatchAdaptRequest,
  BatchAdaptResponse,
  PromptSubmitRequest,
  PromptSubmitResponse,
} from "@/types";

const BASE = "/api";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...init?.headers },
    ...init,
  });
  if (!res.ok) {
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const body = await res.json() as { detail?: string };
      throw new Error(body.detail ?? `API error ${res.status}`);
    }
    throw new Error(`API error ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  images: {
    list: () => request<{ images: unknown[] }>("/images"),
    upload: (file: File) => {
      const body = new FormData();
      body.append("file", file);
      return request<{ id: string; path: string }>("/images/upload", {
        method: "POST",
        body,
        headers: {},
      });
    },
  },

  grade: {
    analyze: (imageId: string) =>
      request<{ scene: unknown; skinTones: boolean }>(`/grade/analyze/${imageId}`),
    apply: (imageId: string, adjustments: unknown) =>
      request<{ preview_url: string; render_time_ms: number }>(`/grade/apply`, {
        method: "POST",
        body: JSON.stringify({ image_id: imageId, adjustments }),
      }),
  },

  prompt: {
    submit: (req: PromptSubmitRequest) =>
      request<PromptSubmitResponse>("/prompt/submit", {
        method: "POST",
        body: JSON.stringify(req),
      }),
  },

  batch: {
    adaptGrade: (req: BatchAdaptRequest) =>
      request<BatchAdaptResponse>("/batch/adapt-grade", {
        method: "POST",
        body: JSON.stringify(req),
      }),
  },

  reference: {
    extract: (dataUrl: string) =>
      request<{ color_profile: unknown }>("/reference/extract", {
        method: "POST",
        body: JSON.stringify({ data_url: dataUrl }),
      }),
  },
};
