import { createStore, get, set, del, values } from "idb-keyval";
import type { SessionRecord } from "@/types";
import { defaultCurveState } from "@/types";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

// Named store so idb-keyval coexists with any other IndexedDB usage in the app.
const sessionStore = createStore("chromaai-sessions", "sessions");

export async function saveSession(session: SessionRecord): Promise<void> {
  await set(session.id, session, sessionStore);
}

export async function getSession(id: string): Promise<SessionRecord | undefined> {
  return get<SessionRecord>(id, sessionStore);
}

export async function listSessions(): Promise<SessionRecord[]> {
  const all = await values<SessionRecord>(sessionStore);
  const cutoff = Date.now() - THIRTY_DAYS_MS;
  return (all as SessionRecord[])
    .filter((s) => s?.updatedAt >= cutoff)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteExpiredSessions(): Promise<void> {
  const all = await values<SessionRecord>(sessionStore);
  const cutoff = Date.now() - THIRTY_DAYS_MS;
  const expired = (all as SessionRecord[]).filter((s) => s?.updatedAt < cutoff);
  await Promise.all(expired.map((s) => del(s.id, sessionStore)));
}

export async function deleteSession(id: string): Promise<void> {
  await del(id, sessionStore);
}

export async function createSession(
  id: string,
  genre: SessionRecord["genre"],
  brief: string
): Promise<void> {
  const now = Date.now();
  const record: SessionRecord = {
    id,
    genre,
    brief,
    createdAt: now,
    updatedAt: now,
    images: [],
    activeImageId: null,
    references: [],
    promptHistory: [],
    hsl: {
      red:     { hue: 0, saturation: 0, luminance: 0 },
      orange:  { hue: 0, saturation: 0, luminance: 0 },
      yellow:  { hue: 0, saturation: 0, luminance: 0 },
      green:   { hue: 0, saturation: 0, luminance: 0 },
      aqua:    { hue: 0, saturation: 0, luminance: 0 },
      blue:    { hue: 0, saturation: 0, luminance: 0 },
      purple:  { hue: 0, saturation: 0, luminance: 0 },
      magenta: { hue: 0, saturation: 0, luminance: 0 },
    },
    colorWheels: {
      lift:   { hue: 0, saturation: 0, luminance: 0 },
      gamma:  { hue: 0, saturation: 0, luminance: 0 },
      gain:   { hue: 0, saturation: 0, luminance: 0 },
      offset: { hue: 0, saturation: 0, luminance: 0 },
    },
    curves: defaultCurveState,
    thumbnailDataUrl: null,
    localLayers: [],
  };
  await saveSession(record);
}
