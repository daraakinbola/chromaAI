"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { clsx } from "clsx";
import type { SessionGenre, SessionRecord } from "@/types";
import { createSession, deleteExpiredSessions, listSessions } from "@/lib/sessionDb";

const GENRES: { value: SessionGenre; label: string; description: string }[] = [
  { value: "portrait",       label: "Portrait",       description: "People, headshots, editorial" },
  { value: "landscape",      label: "Landscape",      description: "Nature, architecture, travel" },
  { value: "documentary",    label: "Documentary",    description: "Photojournalism, street, reportage" },
  { value: "fashion",        label: "Fashion",        description: "Commercial, editorial, lookbooks" },
  { value: "narrative-film", label: "Narrative Film", description: "Cinematic, short films, music videos" },
  { value: "product",        label: "Product",        description: "E-commerce, still life, packshots" },
  { value: "wedding",        label: "Wedding",        description: "Events, ceremonies, lifestyle" },
  { value: "social",         label: "Social / Content", description: "Brand content, influencer, reels" },
];

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "Yesterday";
  return `${days}d ago`;
}

function genreLabel(genre: SessionGenre | null): string {
  return GENRES.find((g) => g.value === genre)?.label ?? "Unknown";
}

export default function SessionSetupPage() {
  const router = useRouter();
  const [genre, setGenre] = useState<SessionGenre | null>(null);
  const [brief, setBrief] = useState("");
  const [recentSessions, setRecentSessions] = useState<SessionRecord[]>([]);

  useEffect(() => {
    deleteExpiredSessions().catch(console.error);
    listSessions()
      .then(setRecentSessions)
      .catch(console.error);
  }, []);

  const handleStart = async () => {
    if (!genre) return;
    const id = crypto.randomUUID();
    await createSession(id, genre, brief);
    router.push(`/workspace?session=${id}`);
  };

  const handleOpenSession = (id: string) => {
    router.push(`/workspace?session=${id}`);
  };

  return (
    <div className="min-h-screen bg-zinc-950 flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-lg">
        {/* Logo */}
        <div className="flex items-center gap-3 mb-10">
          <div
            className="w-9 h-9 rounded-lg flex items-center justify-center"
            style={{ background: "linear-gradient(135deg, #7c3aed 0%, #4c1d95 100%)" }}
          >
            <span className="text-sm font-bold text-white">CA</span>
          </div>
          <div>
            <h1 className="text-xl font-semibold text-zinc-100 tracking-tight">
              Chroma<span className="text-chroma-400">AI</span>
            </h1>
            <p className="text-xs text-zinc-600">AI-assisted color grading</p>
          </div>
        </div>

        <h2 className="text-sm font-semibold text-zinc-300 mb-1">New session</h2>
        <p className="text-xs text-zinc-600 mb-6">
          Providing context improves AI accuracy throughout your session.
        </p>

        {/* Genre selector */}
        <div className="mb-6">
          <label className="block text-[11px] uppercase tracking-wider text-zinc-500 mb-2">
            Genre / context
          </label>
          <div className="grid grid-cols-2 gap-1.5">
            {GENRES.map((g) => (
              <button
                key={g.value}
                onClick={() => setGenre(g.value)}
                className={clsx(
                  "flex flex-col items-start px-3 py-2.5 rounded-lg border text-left transition-all",
                  genre === g.value
                    ? "border-chroma-500/60 bg-chroma-500/10 text-zinc-200"
                    : "border-zinc-800 bg-zinc-900/50 text-zinc-500 hover:border-zinc-700 hover:text-zinc-300"
                )}
              >
                <span className="text-xs font-medium">{g.label}</span>
                <span className="text-[10px] text-zinc-600 mt-0.5">{g.description}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Session brief */}
        <div className="mb-8">
          <label className="block text-[11px] uppercase tracking-wider text-zinc-500 mb-2">
            Session brief <span className="text-zinc-700 normal-case">(optional)</span>
          </label>
          <textarea
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            rows={3}
            placeholder={`e.g. "This is a melancholy short film set in winter. Desaturated, cold, slight film grain."`}
            className="w-full resize-none bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2.5 text-sm text-zinc-300 placeholder:text-zinc-700 focus:outline-none focus:border-chroma-500/50 focus:ring-1 focus:ring-chroma-500/20 transition-colors"
          />
        </div>

        {/* Start button */}
        <button
          onClick={handleStart}
          disabled={!genre}
          className={clsx(
            "w-full py-2.5 rounded-lg text-sm font-medium transition-all",
            genre
              ? "bg-chroma-600 hover:bg-chroma-500 text-white"
              : "bg-zinc-800 text-zinc-600 cursor-not-allowed"
          )}
        >
          Start session
        </button>

        <p className="text-[10px] text-zinc-700 text-center mt-4">
          You can change the genre and import images at any time within the workspace.
        </p>

        {/* Recent sessions */}
        {recentSessions.length > 0 && (
          <div className="mt-10">
            <div className="flex items-center gap-3 mb-3">
              <div className="h-px flex-1 bg-zinc-800" />
              <span className="text-[11px] uppercase tracking-wider text-zinc-600">
                Recent sessions
              </span>
              <div className="h-px flex-1 bg-zinc-800" />
            </div>

            <div className="space-y-1.5">
              {recentSessions.map((session) => (
                <button
                  key={session.id}
                  onClick={() => handleOpenSession(session.id)}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border border-zinc-800 bg-zinc-900/50 hover:border-zinc-700 hover:bg-zinc-900 transition-all text-left group"
                >
                  {/* Thumbnail */}
                  <div className="w-14 h-9 rounded bg-zinc-800 shrink-0 overflow-hidden">
                    {session.thumbnailDataUrl ? (
                      <img
                        src={session.thumbnailDataUrl}
                        alt=""
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center">
                        <span className="text-[10px] text-zinc-600 uppercase font-medium">
                          {session.genre?.[0] ?? "?"}
                        </span>
                      </div>
                    )}
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-zinc-300">
                      {genreLabel(session.genre)}
                      {session.images.length > 0 && (
                        <span className="text-zinc-600 font-normal ml-1.5">
                          · {session.images.length} image{session.images.length !== 1 ? "s" : ""}
                        </span>
                      )}
                    </p>
                    {session.brief ? (
                      <p className="text-[10px] text-zinc-600 truncate mt-0.5">{session.brief}</p>
                    ) : (
                      <p className="text-[10px] text-zinc-700 mt-0.5">No brief</p>
                    )}
                  </div>

                  {/* Timestamp */}
                  <span className="text-[10px] text-zinc-600 shrink-0 group-hover:text-zinc-500 transition-colors">
                    {formatRelativeTime(session.updatedAt)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
