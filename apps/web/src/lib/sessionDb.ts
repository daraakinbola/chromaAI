import { openDB, type IDBPDatabase } from "idb";
import type { SessionRecord } from "@/types";
import { defaultCurveState } from "@/types";

const DB_NAME = "chromaai-sessions";
const DB_VERSION = 1;
const STORE = "sessions";
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDb(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("updatedAt", "updatedAt");
      },
    });
  }
  return dbPromise;
}

export async function saveSession(session: SessionRecord): Promise<void> {
  const db = await getDb();
  await db.put(STORE, session);
}

export async function getSession(id: string): Promise<SessionRecord | undefined> {
  const db = await getDb();
  return db.get(STORE, id);
}

export async function listSessions(): Promise<SessionRecord[]> {
  const db = await getDb();
  const all: SessionRecord[] = await db.getAll(STORE);
  const cutoff = Date.now() - THIRTY_DAYS_MS;
  return all
    .filter((s) => s.updatedAt >= cutoff)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteExpiredSessions(): Promise<void> {
  const db = await getDb();
  const all: SessionRecord[] = await db.getAll(STORE);
  const cutoff = Date.now() - THIRTY_DAYS_MS;
  const expired = all.filter((s) => s.updatedAt < cutoff);
  if (!expired.length) return;
  const tx = db.transaction(STORE, "readwrite");
  await Promise.all(expired.map((s) => tx.store.delete(s.id)));
  await tx.done;
}

export async function deleteSession(id: string): Promise<void> {
  const db = await getDb();
  await db.delete(STORE, id);
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
  };
  await saveSession(record);
}
