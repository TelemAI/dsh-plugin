// Trajectory v5 identity and lineage for DSH (spec
// 2026-07-18-trajectory-v5-context-window-sessions), keyed on what
// the DSH session itself observably is: its id (hashed), its last summarizing
// compaction, and its parent chain. The uuid5/lp/sessionKey primitives are the
// ones every Telem TS plugin carries (copied from openclaw-plugin-telem
// trajectory.ts) with HARNESS_ID = "dsh"; its own suite pins them
// against Python-computed vectors.
//
// Everything here is best-effort: `buildMetadata` never throws out to the tool.
import { createHash, randomUUID } from "node:crypto"

import { deriveEventMessage, foldSurface } from "@deepseek-ai/dsh-session"

export const HARNESS_ID = "dsh"
// Fixed UUID namespace for every client-side uuid5 (never changes).
const NS_TRAJECTORY = "443866ab-1b45-5ed8-979e-52fdad07b810"
// Sentinel for a missing key component (a session with no compaction yet).
const NONE = "none"
const HISTORY_TEXT_CAP = 128000 // per-message cap; tool results can embed whole files
const TOOL_INPUT_CAP = 128000

function sha256hex(x: string): string {
  return createHash("sha256").update(x).digest("hex")
}

// Length-prefix a variable component so concatenation is injective even when a
// component itself contains ":" — "12:foo:bar" can never collide with "3:foo" +
// "3:bar". Applied to every component of every uuid5 name and hashed name.
function lp(s: string): string {
  return String(Buffer.byteLength(s, "utf8")) + ":" + s
}

// uuid5 (RFC 4122 v5, sha1-based): sha1(namespace_bytes ++ utf8(name)), first 16
// bytes with the version nibble set to 5 and the variant bits to 0b10.
function uuid5(namespace: string, name: string): string {
  const nsb = Buffer.from(namespace.replace(/-/g, ""), "hex")
  const hash = createHash("sha1").update(nsb).update(Buffer.from(name, "utf8")).digest()
  const b = Buffer.from(hash.subarray(0, 16))
  b[6] = (b[6] & 0x0f) | 0x50 // version 5
  b[8] = (b[8] & 0x3f) | 0x80 // variant 0b10
  const x = b.toString("hex")
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`
}

// session_key = uuid5(NS, lp(harness) + lp(H(sid)) + lp(comp) + lp(rev)): the
// identity of one context-window generation. DSH has no revert, so rev = none.
function sessionKey(sid: string, comp: string): string {
  return uuid5(NS_TRAJECTORY, lp(HARNESS_ID) + lp(sha256hex(sid)) + lp(comp) + lp(NONE))
}

// fingerprint = H(lp(harness) + lp(sid)): a stable per-session token — the hash
// is what leaves the machine, never the raw id.
function fingerprint(sid: string): string {
  return sha256hex(lp(HARNESS_ID) + lp(sid))
}

// snapshot_node_key = uuid5(NS, lp(harness) + lp(H(sid)) + lp(msg) + lp("snap")):
// an ancestor's spawn-point snapshot, keyed on the message at which it spawned.
function snapshotNodeKey(sid: string, msg: string): string {
  return uuid5(NS_TRAJECTORY, lp(HARNESS_ID) + lp(sha256hex(sid)) + lp(msg) + lp("snap"))
}

// ---------------------------------------------------------------------------
// What the plugin reads from a DSH session — structural, and only what a live
// `Session` still exposes without a deprecated history read: its header and
// its derived surface. A PARENT's raw events come ONLY from DSH's session-query
// service (`ctx.sessionQuery.observeSession(id, { signal, projectionMode })`,
// a disposable lease over `{ header, inheritedEventCount, events }`), the
// sanctioned async reader: live-preferred (the live log's cached immutable
// snapshot while the parent is live — no clone, no replay; storage otherwise,
// LRU-cached by revision), cancellable, and valid for a FORK child too (the
// engine's `readSession` replay-validates and rejects a seeded log, so it is
// not used). The dsh-base bundle mounts the service (`session-query-sqlite`
// with `openAt: never` keeps exact reads available). Never the live object's
// deprecated sync readers, and never `sessionPersistence` directly — its real
// surface is create/open/flush/stat/list, and the query service's cold path
// already IS that read. The last compaction is a projection (`compaction.ts`).
// ---------------------------------------------------------------------------
type Block =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool-call"; id: string; name: string; arguments: string }
  | { type: "tool-result"; toolCallId: string; isError?: boolean }
  | { type: string }
type MessageLike = { id: string; role: string; content: readonly Block[] }
type EventLike = { type: string; seq: number; time: number; data: any }
type HeaderLike = { id: string; createdAt: number; parentSession?: string }
export type SessionObservationLike = {
  readonly header: HeaderLike
  /** Immutable, contiguous from seq 0 (a fork child's inherited prefix included). Materialized on first read. */
  readonly events: readonly EventLike[]
  [Symbol.dispose](): void
}
export type SessionLike = {
  header: HeaderLike
  deriveMessages(): readonly MessageLike[]
}
export type LineageDeps = {
  /** Live sessions: the header (lineage pointers) only — never their events. */
  sessions?: { get(id: string): { header: HeaderLike } | undefined }
  /**
   * DSH's session-query service: the one explicit, async history read. A
   * structural pick of `SessionQueryEngine.observeSession` (a `SessionObservation`
   * lease: `{ header, events, [Symbol.dispose] }`); `index.ts` assigns the real
   * service here, which is what type-checks the seam against DSH.
   */
  sessionQuery?: {
    observeSession(id: string, options?: { signal?: AbortSignal; projectionMode?: "all" | "none" }): Promise<SessionObservationLike>
  }
  /** The last summarizing compaction of a LIVE session, from the projection; undefined = none known. */
  compactionOf?: (session: SessionLike) => string | undefined
  /** Local diagnostics (stderr): a degraded lineage is otherwise indistinguishable from "no parent". */
  warn?: (message: string) => void
}

export type HistoryMessage = { role: string; content: string; reasoning?: string }

/**
 * DSH messages → trajectory history rows, the same contract the other TS
 * plugins emit: assistant text is content, reasoning is reasoning, each
 * tool-call block becomes a compact `[tool name: status args]` marker whose
 * status comes from the matching tool-result (a user-role message carrying one
 * tool-result block — folded into the marker, never a row of its own). The
 * current call is `running` with its LIVE args.
 */
export function flattenMessages(
  messages: readonly MessageLike[],
  current?: { callIds: readonly (string | undefined)[]; args: unknown },
): HistoryMessage[] {
  const status = new Map<string, string>()
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === "tool-result") {
        const b = block as { toolCallId: string; isError?: boolean }
        status.set(b.toolCallId, b.isError ? "error" : "completed")
      }
    }
  }
  const currentIds = new Set((current?.callIds ?? []).filter(Boolean))
  const history: HistoryMessage[] = []
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue
    const contentPieces: string[] = []
    const reasoningPieces: string[] = []
    for (const block of message.content) {
      if (block.type === "text") contentPieces.push((block as { text: string }).text)
      else if (block.type === "reasoning") reasoningPieces.push((block as { text: string }).text)
      else if (block.type === "tool-call") {
        const b = block as { id: string; name: string; arguments: string }
        const running = currentIds.has(b.id)
        let input = ""
        try {
          const raw = running ? JSON.stringify(current!.args) : b.arguments
          if (raw) input = " " + raw.slice(0, TOOL_INPUT_CAP)
        } catch {
          // non-serializable input; omit
        }
        const state = running ? "running" : (status.get(b.id) ?? "pending")
        contentPieces.push(`[tool ${b.name}: ${state}${input}]`)
      }
    }
    const content = contentPieces.join("\n").slice(0, HISTORY_TEXT_CAP)
    const reasoning = reasoningPieces.join("\n").slice(0, HISTORY_TEXT_CAP)
    if (!content && !reasoning) continue
    const entry: HistoryMessage = { role: message.role, content }
    if (reasoning) entry.reasoning = reasoning
    history.push(entry)
  }
  return history
}

/**
 * The id of the last SUMMARIZING compaction (a prune-only pass is not one), or
 * "none" — over a PERSISTED log only (a parent snapshot); a live session's
 * comes from the projection.
 */
function lastCompactionId(events: readonly EventLike[]): string {
  let last = NONE
  for (const event of events) {
    if (event.type === "compaction/summary" && typeof event.data?.compactionId === "string") {
      last = event.data.compactionId
    }
  }
  return last
}

/**
 * An ancestor frozen at the moment its child was created: the surface as it
 * stood then (folded through DSH's own canonical fold), the last assistant
 * message before that moment as the spawn point, and the compaction generation
 * in force. Everything after `childCreatedAt` is the parent moving on.
 */
function parentSnapshot(header: HeaderLike, events: readonly EventLike[], childCreatedAt: number) {
  // Fold the log AS IT STOOD at the child's creation: the contiguous PREFIX up
  // to the last event stamped at or before that moment (events are appended
  // in time order; seq === index). Folding the whole log and filtering the
  // nodes afterwards would let a compaction the parent ran AFTER spawning
  // shadow the pre-spawn surface and hollow the snapshot — the frozen ancestor
  // must not change as the parent moves on.
  let cut = 0
  for (let i = 0; i < events.length; i++) if (events[i].time <= childCreatedAt) cut = i + 1
  const before = events.slice(0, cut)
  const nodes = foldSurface(before as never).nodes
    .map((seq) => before[seq])
    .filter((event): event is EventLike => event !== undefined)
  const messages = nodes.map((event) => deriveEventMessage(event as never)).filter(Boolean) as MessageLike[]
  let spawn: { id: string; time: number } | undefined
  for (const event of nodes) {
    if (event.type === "assistant/message" && typeof event.data?.message?.id === "string") {
      spawn = { id: event.data.message.id, time: event.time }
    }
  }
  const key = snapshotNodeKey(header.id, spawn?.id ?? NONE)
  return {
    key,
    entry: {
      session_key: sessionKey(header.id, lastCompactionId(before)),
      fingerprint: fingerprint(header.id),
      node_key: key,
      parent_node_key: null as string | null,
      context: flattenMessages(messages),
      spawned_at: spawn ? new Date(spawn.time).toISOString() : null,
    },
  }
}

/**
 * An ancestor whose header is known but whose events could not be read: every
 * key is derived from the id alone (no compaction, no spawn message), the
 * context is empty. Lossy, but it is a FULL snapshot entry — valid UUIDs in
 * every field the backend parses — so the child still links to its parent.
 * Sibling children of the same unreadable parent converge on one node.
 */
function keysOnlySnapshot(header: HeaderLike) {
  const key = snapshotNodeKey(header.id, NONE)
  return {
    key,
    entry: {
      session_key: sessionKey(header.id, NONE),
      fingerprint: fingerprint(header.id),
      node_key: key,
      parent_node_key: null as string | null,
      context: [] as HistoryMessage[],
      spawned_at: null as string | null,
    },
  }
}

type AncestorRead =
  | { kind: "full"; header: HeaderLike; events: readonly EventLike[] }
  | { kind: "keys-only"; header: HeaderLike; reason: string }
  | { kind: "hole"; reason: string }

/**
 * One ancestor, best source first: (1) the session-query service — header AND
 * events, live-preferred; (2) the live store's header alone, which still
 * links; (3) nothing. There is deliberately no `sessionPersistence.open`
 * fallback: the query service's cold path is that read, the dsh-base bundle
 * mounts the service, and (2) already preserves the link. The lease is
 * disposed as soon as the (immutable) events are in hand. An abort is
 * rethrown, never degraded into a keys-only ancestor.
 */
async function readAncestor(id: string, deps: LineageDeps, signal?: AbortSignal): Promise<AncestorRead> {
  let reason = "no sessionQuery service"
  if (deps.sessionQuery) {
    signal?.throwIfAborted()
    try {
      const lease = await deps.sessionQuery.observeSession(id, { signal, projectionMode: "none" })
      try {
        signal?.throwIfAborted()
        const { header, events } = lease
        if (header && Array.isArray(events)) return { kind: "full", header, events }
        reason = "observeSession returned no header/events"
      } finally {
        lease[Symbol.dispose]?.()
      }
    } catch (error) {
      if (signal?.aborted) throw error
      reason = `observeSession failed: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  const header = deps.sessions?.get(id)?.header
  if (header) return { kind: "keys-only", header, reason }
  return { kind: "hole", reason: `${reason}; not in the live store` }
}

export type MetadataInput = {
  session?: SessionLike
  callId: string
  rootCallId?: string
  args: unknown
  kind: "search" | "fetch"
  goal?: string
  signal?: AbortSignal
}

/**
 * The trajectory-v5 wire payload for one call. Without a session (no calling
 * agent) it is goal-only; with one it carries the context-window key, the
 * fingerprint, the history, and the root-first ancestor chain. Bookkeeping
 * never fails a search: any failure degrades to whatever was computed so far.
 */
export async function buildMetadata(input: MetadataInput, deps: LineageDeps): Promise<Record<string, unknown>> {
  const metadata: Record<string, unknown> = {
    node_key: randomUUID(),
    kind: input.kind,
    parent_node_key: null,
    ancestors: [],
  }
  if (input.goal) metadata.goal = input.goal
  const session = input.session
  // No session, or one without an id, is goal-only: no key can be derived, and
  // that is not a lineage failure worth a notice.
  if (!session || typeof session.header?.id !== "string") return metadata
  try {
    metadata.session_key = sessionKey(session.header.id, deps.compactionOf?.(session) ?? NONE)
    metadata.fingerprint = fingerprint(session.header.id)
    metadata.message_history = flattenMessages(session.deriveMessages(), {
      callIds: [input.callId, input.rootCallId],
      args: input.args,
    })

    // Walk self -> root, child-first. A `visited` set bounds the walk so a
    // corrupted parent pointer can never hang the tool call.
    type Link = { materialized: boolean; key?: string; entry?: Record<string, unknown> }
    const lineage: Link[] = []
    const visited = new Set<string>([session.header.id])
    let childCreatedAt = session.header.createdAt
    let cur = session.header.parentSession
    while (cur && !visited.has(cur)) {
      visited.add(cur)
      const read = await readAncestor(cur, deps, input.signal)
      if (read.kind === "hole") {
        // Unreadable: no snapshot, and no trusted parent pointer, so the walk stops here.
        say(deps, `telem: lineage for session ${session.header.id} degraded: parent ${cur} unreadable (${read.reason}); chain stops here`)
        lineage.push({ materialized: false })
        break
      }
      if (read.kind === "keys-only") {
        say(deps, `telem: lineage for session ${session.header.id} degraded: ${read.reason} for parent ${cur}; ancestor emitted keys-only`)
      }
      const snapshot = read.kind === "full" ? parentSnapshot(read.header, read.events, childCreatedAt) : keysOnlySnapshot(read.header)
      lineage.push({ materialized: true, key: snapshot.key, entry: snapshot.entry })
      childCreatedAt = read.header.createdAt
      cur = read.header.parentSession
    }
    lineage.reverse() // root-first

    const ancestors: Record<string, unknown>[] = []
    for (let i = 0; i < lineage.length; i++) {
      const link = lineage[i]
      if (!link.materialized || !link.entry) continue
      const prev = lineage[i - 1] // the shallower member = real parent
      // NULL across a hole; never skip up to a surviving grandparent.
      link.entry.parent_node_key = prev && prev.materialized ? prev.key : null
      ancestors.push(link.entry)
    }
    // The node's parent is the DIRECT parent's snapshot; a hole there is null.
    const direct = lineage[lineage.length - 1]
    metadata.parent_node_key = direct && direct.materialized ? direct.key : null
    metadata.ancestors = ancestors
  } catch (error) {
    // Best effort: keep whatever was computed; a lineage failure is not a search failure.
    metadata.parent_node_key = null
    metadata.ancestors = []
    // A cancelled call is not a lineage failure: the POST that follows fails on
    // the same signal, and the notice must not spend the session's one warning.
    if (!input.signal?.aborted) {
      say(deps, `telem: lineage for session ${session.header.id} dropped: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return metadata
}

/** Diagnostics never fail a search either: a throwing sink is swallowed. */
function say(deps: LineageDeps, message: string): void {
  try {
    deps.warn?.(message)
  } catch {
    // a broken sink is not our problem
  }
}
