// The last SUMMARIZING compaction of a DSH session, kept as a PROJECTION over
// delivered events — never a synchronous read of the session's event history.
// DSH deprecated `Session.eventAt/snapshotEvents/ownEvents` (agent note
// 2026-09-09-deprecate-synchronous-session-event-reads: new production calls
// are prohibited; the storage direction is to stop keeping the whole log in
// memory), and `Session` no longer exposes `events` at all. Two seams, both
// installed at load; the reader prefers the first while it is mounted:
//
//   1. DSH's session-projection registry (`ctx.sessionProjections`, the
//      sanctioned reader — agent note 2026-08-19-session-projection-mandatory-
//      seam): a host-only unit the registry drives over every committed event
//      and, for a session that predates the registration or was RESUMED from
//      storage, folds over the in-memory log itself on first read. Reached
//      through `ctx.inject`, so it is picked up whenever the composition mounts
//      it, before or after this plugin, and let go when it unloads.
//   2. The `session/event` firehose (`ctx.on`): the same fold kept in a map by
//      session id, dropped on `session/disposed`. Constructor seeds never emit,
//      so under this seam alone a resumed session reads as "no compaction yet"
//      until its next one — the registry closes exactly that gap.
//
// Fallback if neither could ever be reached would be an explicit async read
// through DSH's session-query service (`ctx.sessionQuery.observeSession`, the
// reader lineage uses for a PARENT's log in trajectory.ts); a plugin can
// always subscribe, so it is not needed here. NEVER a deprecated reader
// behind a lint waiver.
//
// The registry validates persisted unit state with a zod schema. zod is the
// registry's own dependency, so it is present exactly when the registry is —
// loaded lazily inside the injection, never bundled (600 KB for a one-field
// schema) and never imported at plugin load, so a composition without the
// registry never needs it.
import type { Context } from "@deepseek-ai/cordis"
import type { Session, SessionEvent, SessionHeader } from "@deepseek-ai/dsh-session"
import type { SessionProjectionRegistry } from "@deepseek-ai/dsh-session-projection"

/** Host-only projection key (never on the wire to DSH clients — no `wire` block). */
export const COMPACTION_KEY = "telemCompaction"
/** Plain JSON, as the persisted projection cache requires; absent = no compaction yet. */
export type CompactionState = { compactionId?: string }

declare module "@deepseek-ai/dsh-session-projection/types" {
  interface SessionProjectionStateMap {
    telemCompaction: CompactionState
  }
}

const INITIAL: CompactionState = Object.freeze({})

/** The compaction id a `compaction/summary` event carries, or undefined for any other event. */
function summarizedCompactionId(event: { type: string; data?: unknown }): string | undefined {
  if (event.type !== "compaction/summary") return undefined
  const id = (event.data as { compactionId?: unknown } | null | undefined)?.compactionId
  return typeof id === "string" ? id : undefined
}

// The pure fold. A prune-only pass (`compaction/prune`) is not a summarizing
// compaction and leaves the state untouched — and untouched means the SAME
// reference, which is the registry's "nothing changed" signal.
function fold(state: CompactionState, event: SessionEvent): CompactionState {
  const id = summarizedCompactionId(event)
  return id === undefined ? state : { compactionId: id }
}

/** What the lineage reads: the session's last summarizing compaction id, if any. */
export type CompactionReader = (session: { header: SessionHeader | { id: string } }) => string | undefined

/**
 * Install both seams on the plugin's context (everything unwinds with the
 * plugin fiber) and return the reader. Reading a fake or detached session
 * through the registry throws; callers treat any throw as "unknown".
 */
export function installCompactionProjection(ctx: Context): CompactionReader {
  // Seam 2, always: the firehose map.
  const latest = new Map<string, string>()
  ctx.on("session/event", (session, event) => {
    const id = summarizedCompactionId(event)
    if (id !== undefined) latest.set(session.id, id)
  })
  ctx.on("session/disposed", (session) => {
    latest.delete(session.id)
  })

  // Seam 1, while mounted: the registry unit. Registered only once zod has
  // loaded; until then (and if it cannot load) the map above answers.
  let registry: SessionProjectionRegistry | undefined
  ctx.inject(["sessionProjections"], async (inner) => {
    const { z } = await import("zod")
    inner.sessionProjections.register({
      key: COMPACTION_KEY,
      stateSchema: z.object({ compactionId: z.string().optional() }),
      stateVersion: 1,
      init: () => INITIAL,
      apply: fold,
    })
    inner.effect(() => {
      registry = inner.sessionProjections
      return () => {
        registry = undefined
      }
    })
  })

  return (session) => {
    if (registry) return registry.stateOf(session as Session, COMPACTION_KEY)?.compactionId
    return latest.get(session.header.id)
  }
}
