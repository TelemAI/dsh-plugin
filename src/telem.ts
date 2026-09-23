// Search/fetch against the Telem backend, the canonical values DSH validates,
// and the model-facing renderers. Everything the backend contract touches lives
// here; `index.ts` only wires it into DSH.
//
// The sentinel-delimited render region below is COPIED BYTE-FOR-BYTE from
// the sibling plugin (the canonical copy; its own suite pins
// the equality), as is `formatFetchedRow`/`formatFetchResults` after it. Do not
// edit them here — edit the canonical copy and re-copy.

// telem_fetch (fetch-interactions spec): client-side mirror of the server's
// web_fetch_max_urls default, and the per-URL inline-content cap (the backend's
// inline cap — 5 × 20000 also keeps a full batch inside 100 KB of output).
const FETCH_MAX_URLS = 5
const FETCH_CONTENT_CAP = 20000

import type { InferValue } from "@deepseek-ai/dsh-tools"

export const DEFAULT_TELEM_BASE_URL = "https://router.telem.ai"

// telem-render:begin
// ---------------------------------------------------------------------------
// Search rendering — the V2 normalized envelope (search I/O normalization
//-) turned into the text the model reads. PORTABLE BY CONTRACT: this
// whole region is copied verbatim into the openclaw plugin, so it may not touch
// anything host-specific (no opencode client, no tool context, no env) — it is
// a pure function of one interaction body.
//
// Render budget ( the contract, final):
//   - `summary` renders WHOLE (the server already caps it at 1000 chars);
//   - `excerpt` renders at most 4 entries of at most 1000 chars each, with an
//     elision note when entries were dropped (real entries measure 1-14 KB);
//   - `full_content` is NEVER rendered inline — depth is telem_fetch's job;
//   - per-result `[<provider>]` tag: the schema keeps every provider's list
//     separate ( — no merged list, no global rank), so every row says who
//     found it;
//   - the query-level `answer`/`related` block leads each query section;
//   - a failed or degraded run contributes ONE line instead of rows;
//   - only a BATCH carries a total cap; a single-query render has none.
// A field that a tier did not request, or that a provider could not supply, is
// simply absent from the output — the envelope's own presence rule.
//
// Values are single-line by construction — provider markdown cannot outrank the
// renderer's structure.
// ---------------------------------------------------------------------------

const RENDER_EXCERPT_MAX_ENTRIES = 4
const RENDER_EXCERPT_MAX_CHARS = 1000
const RENDER_RELATED_MAX_ITEMS = 6
const RENDER_TOTAL_CAP = 128000

// EVERY provider value goes through here before it is rendered. Real summaries
// and excerpts are markdown with newlines (a parallel summary opens with `#`
// and `##` headings), and a value allowed to start a line would forge the
// renderer's own structure — a heading outranking `### Query N`, or a bare line
// that reads as content nobody attributed. Folding interior whitespace keeps
// every byte of the value on the line its label owns.
function line(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\s*\n\s*/g, " ") : ""
}

// One result row. URL is the only required field, so it anchors the row;
// everything else is a labelled line that appears only when it carries content.
function renderRow(provider: string, row: any): string {
  const lines = [`[${provider}] URL: ${line(row?.url)}`]
  const title = line(row?.title)
  if (title) lines.push(`Title: ${title}`)
  const summary = line(row?.summary)
  if (summary) lines.push(`Summary: ${summary}`)

  const entries = (Array.isArray(row?.excerpt) ? row.excerpt : [])
    .map((entry: unknown) => line(entry))
    .filter(Boolean)
  if (entries.length) {
    lines.push("Excerpt:")
    for (const entry of entries.slice(0, RENDER_EXCERPT_MAX_ENTRIES)) {
      // The ellipsis marks the cut and sits OUTSIDE the budget, exactly as the
      // server's own the contract does for summaries.
      const cut = entry.length > RENDER_EXCERPT_MAX_CHARS
      lines.push(`- ${cut ? entry.slice(0, RENDER_EXCERPT_MAX_CHARS) + "…" : entry}`)
    }
    const dropped = entries.length - RENDER_EXCERPT_MAX_ENTRIES
    if (dropped > 0) lines.push(`…(${dropped} more excerpt entries)`)
  }

  const published = line(row?.publish_date)
  if (published) lines.push(`Published: ${published}`)
  const source = row?.source
  if (source && typeof source === "object") {
    // The domain is already in the URL, so it only earns a line when the
    // provider named a publication or an author to go with it.
    const name = line(source.name) || line(source.domain)
    const author = line(source.author)
    if (author) lines.push(`Source: ${name ? `${name} by ${author}` : `by ${author}`}`)
    else if (line(source.name)) lines.push(`Source: ${name}`)
  }
  // `full_content` is deliberately not rendered here — see the budget above.
  return lines.join("\n")
}

// The query-level block. These keys are per RUN, but they answer the
// QUERY, so the section carries one block: the first answer any provider
// returned, and the related items pooled across providers (questions first,
// then searches), deduped and capped.
function renderQueryBlock(runs: any[]): string[] {
  const lines: string[] = []
  let answer = ""
  const questions: string[] = []
  const searches: string[] = []
  for (const run of runs) {
    const payload = run?.output_payload
    if (!payload || typeof payload !== "object") continue
    if (!answer) answer = line(payload.answer)
    const related = payload.related
    if (!related || typeof related !== "object") continue
    for (const item of Array.isArray(related.questions) ? related.questions : []) {
      const text = line(item)
      if (text) questions.push(text)
    }
    for (const item of Array.isArray(related.searches) ? related.searches : []) {
      const text = line(item)
      if (text) searches.push(text)
    }
  }
  if (answer) lines.push(`Answer: ${answer}`)
  const related = [...new Set([...questions, ...searches])].slice(0, RENDER_RELATED_MAX_ITEMS)
  if (related.length) lines.push(`Related: ${related.join(", ")}`)
  return lines
}

// Everything one query produced: its block, then each run's contribution in run
// order (rows, or a single line for a run that failed or degraded).
function renderQuerySection(runs: any[]): string {
  const blocks: string[] = []
  const rowBlocks: string[] = []
  for (const run of runs) {
    const provider = line(run?.preprocessor_name) || "unknown"
    const payload = run?.output_payload
    const rows = Array.isArray(payload?.results) ? payload.results : null
    const error = run?.error
    if (run?.status === "failed" || (!rows && error)) {
      // ONE line, like every other value: provider errors are often multi-line
      // (`…\nFor more information check: …`) and an untagged continuation line
      // reads like content.
      const message = line(error?.message) || line(error?.type) || "unknown error"
      rowBlocks.push(`[${provider}] failed: ${message}`)
      continue
    }
    if (!rows?.length) {
      // A SUCCEEDED run whose normalize raised ships the minimal envelope —
      // no rows plus one `normalize_failed` warning. Say so, or the run is
      // invisible next to its healthy siblings and reads as "nothing found".
      // A genuinely empty result set carries no such warning and stays silent.
      const warnings = Array.isArray(payload?.warnings) ? payload.warnings : []
      const degraded = warnings.find((warning: any) => warning?.code === "normalize_failed")
      if (degraded) {
        const message = line(degraded.message) || "normalize_failed"
        rowBlocks.push(`[${provider}] no rows (${message})`)
      }
      continue
    }
    for (const row of rows) rowBlocks.push(renderRow(provider, row))
  }
  const head = renderQueryBlock(runs)
  if (head.length) blocks.push(head.join("\n"))
  blocks.push(...(rowBlocks.length ? rowBlocks : ["No results found."]))
  return blocks.join("\n\n")
}

function formatSearchResults(interaction: any): string {
  // Group the runs by the query that produced them. A batch request runs N
  // queries as ONE interaction and the backend tags every run with a 0-based
  // batch_index and its query text; a single-query interaction has every run at
  // batch_index 0 and renders as one unlabelled section.
  const groups = new Map<number, { query: string; runs: any[] }>()
  for (const run of interaction?.preprocessor_runs ?? []) {
    const index = typeof run?.batch_index === "number" ? run.batch_index : 0
    let group = groups.get(index)
    if (!group) groups.set(index, (group = { query: "", runs: [] }))
    // The query is a value too — the MODEL supplies it (page text copied into a
    // search is a real path), so it goes through the same fold and can never
    // forge a section header or a provider row from inside its own label.
    if (!group.query) group.query = line(run?.query)
    group.runs.push(run)
  }
  const ordered = [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([, group]) => group)

  // One query (or a response carrying no runs): field-level caps only.
  if (ordered.length <= 1) return renderQuerySection(ordered[0]?.runs ?? [])

  // A batch: one labelled section per query so the model can attribute every
  // row to the query that produced it, plus the one total cap in the renderer —
  // a 32-query batch is the only realistic way to blow up a tool result.
  const text = ordered
    .map((group, i) => {
      const label = group.query ? `Query ${i + 1}: ${group.query}` : `Query ${i + 1}`
      return `### ${label}\n${renderQuerySection(group.runs)}`
    })
    .join("\n\n")
  if (text.length <= RENDER_TOTAL_CAP) return text
  return (
    text.slice(0, RENDER_TOTAL_CAP) +
    `\n\n…(batch output truncated at ${RENDER_TOTAL_CAP} characters — re-run the remaining queries in a smaller batch)`
  )
}
// telem-render:end

// telem_fetch pre-validation (fetch-interactions spec): friendly errors
// BEFORE any network request — the server's 400s stay the authority, this only
// saves the round trip. Returns the trimmed, deduped URL list.
function validateFetchUrls(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("telem_fetch requires at least one URL in `urls`.")
  }
  for (const item of raw) {
    if (typeof item !== "string") {
      throw new Error("telem_fetch: every item in `urls` must be a URL string.")
    }
  }
  const trimmed = (raw as string[]).map((url) => url.trim())
  for (const url of trimmed) {
    if (!/^https?:\/\//i.test(url)) {
      throw new Error(
        `telem_fetch only reads http(s) URLs, got ${JSON.stringify(url)}. ` +
          "Pass absolute URLs starting with http:// or https://.",
      )
    }
  }
  const urls = [...new Set(trimmed)]
  if (urls.length > FETCH_MAX_URLS) {
    throw new Error(
      `telem_fetch reads at most ${FETCH_MAX_URLS} URLs per call (got ${urls.length}). ` +
        "Split the read into multiple calls.",
    )
  }
  return urls
}

// One section per fetched URL. Succeeded rows carry the page's inline content,
// capped at FETCH_CONTENT_CAP per URL (the backend's own inline cap — the note
// covers both the client-side cut and a backend-truncated row). Failed rows
// render their status and error briefly.
function formatFetchedRow(row: any): string {
  const url = typeof row?.url === "string" ? row.url : ""
  const title = typeof row?.title === "string" ? row.title : ""
  const status = typeof row?.status === "string" ? row.status : "unknown"
  const header = `### ${url}` + (title ? `\nTitle: ${title}` : "") + `\nStatus: ${status}`
  if (status !== "succeeded") {
    const error = row?.error
    const brief =
      error && (error.type || error.message)
        ? `\nError: ${[error.type, error.message].filter(Boolean).join(": ")}`
        : ""
    return header + brief
  }
  const content = typeof row?.content === "string" ? row.content : ""
  const truncated = content.length > FETCH_CONTENT_CAP || row?.content_truncated === true
  const note = truncated ? `\n\n[Content truncated at ${FETCH_CONTENT_CAP} characters]` : ""
  return `${header}\n\n${content.slice(0, FETCH_CONTENT_CAP)}${note}`
}

// Render a fetch interaction. The current backend runs fetch as a FIRST-stage
// unit: one `web_fetch` preprocessor run per URL (batch_index order), each
// carrying its fetched_results row. Older backends ran it as the
// `web_fetch_cache` postprocessor — kept as a fallback so the tool works
// against either deployment.
// A missing run or an empty batch degrades to a clear message, never a throw.
function formatFetchResults(interaction: any): string {
  const preRuns = (interaction?.preprocessor_runs ?? []).filter(
    (r: any) => r?.preprocessor_name === "web_fetch",
  )
  const rows: any[] = []
  if (preRuns.length > 0) {
    preRuns.sort((a: any, b: any) => (a?.batch_index ?? 0) - (b?.batch_index ?? 0))
    for (const run of preRuns) {
      const fetched = run?.output_payload?.fetched_results
      if (Array.isArray(fetched)) rows.push(...fetched)
    }
  } else {
    // Older backend: fetch ran as the web_fetch_cache postprocessor.
    const run = (interaction?.postprocessor_runs ?? []).find(
      (r: any) => r?.postprocessor_name === "web_fetch_cache",
    )
    const fetched = run?.output_payload?.fetched_results
    if (Array.isArray(fetched)) rows.push(...fetched)
  }
  if (rows.length === 0) {
    return "The fetch produced no results (the backend returned no web fetch output)."
  }
  return rows.map(formatFetchedRow).join("\n\n")
}

// ---------------------------------------------------------------------------
// The V2 capability gate. The renderer reads ONE shape — the
// normalized envelope — and has no alias ladder to fall back on, so a pre-V2
// server must fail the tool loudly rather than render an empty result set that
// reads like "the web had nothing". Only telem_search is gated.
// ---------------------------------------------------------------------------
export function assertV2Envelope(interaction: any): void {
  const version = interaction?.normalized_schema_version
  if (!Number.isInteger(version) || (version as number) < 2) {
    throw new Error(
      `Telem server answered without the V2 normalized contract (normalized_schema_version=${version}); ` +
        "upgrade the backend or point TELEM_BASE_URL at a V2 deployment",
    )
  }
}

// ---------------------------------------------------------------------------
// Canonical values. DSH renders and presents ONLY from the value `execute`
// returns, validated against `output.schema` and snapshotted as lossless JSON —
// an `undefined` property anywhere fails the whole call. So the value is the
// exact subset of the interaction the renderers above read (no ids, no billing,
// no full_content), built by copying only correctly-typed fields and OMITTING
// everything else (the backend sends `null` for absent optionals).
// ---------------------------------------------------------------------------

const STRING = { type: "string" } as const
const STRINGS = { type: "array", items: STRING } as const

const RESULT_ROW = {
  type: "object",
  additionalProperties: false,
  properties: {
    url: { ...STRING, required: true },
    title: STRING,
    summary: STRING,
    excerpt: STRINGS,
    publish_date: STRING,
    source: {
      type: "object",
      additionalProperties: false,
      properties: { name: STRING, domain: STRING, author: STRING },
    },
  },
} as const

export const SEARCH_VALUE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    session_id: STRING,
    preprocessor_runs: {
      type: "array",
      required: true,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          batch_index: { type: "integer" },
          query: STRING,
          preprocessor_name: { ...STRING, required: true },
          status: { ...STRING, required: true },
          error: {
            type: "object",
            additionalProperties: false,
            properties: { type: STRING, message: STRING },
          },
          output_payload: {
            type: "object",
            additionalProperties: false,
            properties: {
              results: { type: "array", items: RESULT_ROW },
              answer: STRING,
              related: {
                type: "object",
                additionalProperties: false,
                properties: { questions: STRINGS, searches: STRINGS },
              },
              warnings: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: { code: { ...STRING, required: true }, message: STRING },
                },
              },
            },
          },
        },
      },
    },
  },
} as const

export const FETCH_VALUE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    session_id: STRING,
    preprocessor_runs: {
      type: "array",
      required: true,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          batch_index: { type: "integer" },
          preprocessor_name: { ...STRING, required: true },
          output_payload: {
            type: "object",
            additionalProperties: false,
            properties: {
              fetched_results: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    url: { ...STRING, required: true },
                    title: STRING,
                    status: { ...STRING, required: true },
                    error: {
                      type: "object",
                      additionalProperties: false,
                      properties: { type: STRING, message: STRING },
                    },
                    content: STRING,
                    content_truncated: { type: "boolean" },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
} as const

export type SearchValue = InferValue<typeof SEARCH_VALUE_SCHEMA>
export type FetchValue = InferValue<typeof FETCH_VALUE_SCHEMA>

type Rec = Record<string, unknown>
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined)
const strs = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined
/** Copy `value` under `key` only when it is present — never write `undefined`. */
function put(out: Rec, key: string, value: unknown): void {
  if (value !== undefined) out[key] = value
}
/** An object of only-present keys, or `undefined` when nothing survived. */
function some(out: Rec): Rec | undefined {
  return Object.keys(out).length ? out : undefined
}

function trimError(v: unknown): Rec | undefined {
  if (!isRec(v)) return undefined
  const out: Rec = {}
  put(out, "type", str(v.type))
  put(out, "message", str(v.message))
  return some(out)
}

function trimRow(v: unknown): Rec | undefined {
  if (!isRec(v) || typeof v.url !== "string") return undefined
  const out: Rec = { url: v.url }
  put(out, "title", str(v.title))
  put(out, "summary", str(v.summary))
  put(out, "excerpt", strs(v.excerpt))
  put(out, "publish_date", str(v.publish_date))
  if (isRec(v.source)) {
    const source: Rec = {}
    put(source, "name", str(v.source.name))
    put(source, "domain", str(v.source.domain))
    put(source, "author", str(v.source.author))
    put(out, "source", some(source))
  }
  return out
}

function trimSearchRun(v: unknown): Rec | undefined {
  if (!isRec(v)) return undefined
  const out: Rec = {
    preprocessor_name: str(v.preprocessor_name) ?? "unknown",
    status: str(v.status) ?? "unknown",
  }
  if (Number.isInteger(v.batch_index)) out.batch_index = v.batch_index
  put(out, "query", str(v.query))
  put(out, "error", trimError(v.error))
  if (isRec(v.output_payload)) {
    const p = v.output_payload
    const payload: Rec = {}
    if (Array.isArray(p.results)) payload.results = p.results.map(trimRow).filter(Boolean)
    put(payload, "answer", str(p.answer))
    if (isRec(p.related)) {
      const related: Rec = {}
      put(related, "questions", strs(p.related.questions))
      put(related, "searches", strs(p.related.searches))
      put(payload, "related", some(related))
    }
    if (Array.isArray(p.warnings)) {
      payload.warnings = p.warnings.flatMap((w: unknown) => {
        if (!isRec(w) || typeof w.code !== "string") return []
        const warning: Rec = { code: w.code }
        put(warning, "message", str(w.message))
        return [warning]
      })
    }
    out.output_payload = payload
  }
  return out
}

function trimFetchedRow(v: unknown): Rec | undefined {
  if (!isRec(v) || typeof v.url !== "string") return undefined
  const out: Rec = { url: v.url, status: str(v.status) ?? "unknown" }
  put(out, "title", str(v.title))
  put(out, "error", trimError(v.error))
  put(out, "content", str(v.content))
  if (typeof v.content_truncated === "boolean") out.content_truncated = v.content_truncated
  return out
}

function trimFetchRun(v: unknown): Rec | undefined {
  if (!isRec(v)) return undefined
  const out: Rec = { preprocessor_name: str(v.preprocessor_name) ?? "unknown" }
  if (Number.isInteger(v.batch_index)) out.batch_index = v.batch_index
  if (isRec(v.output_payload) && Array.isArray(v.output_payload.fetched_results)) {
    out.output_payload = {
      fetched_results: v.output_payload.fetched_results.map(trimFetchedRow).filter(Boolean),
    }
  }
  return out
}

function runsOf(interaction: unknown): unknown[] {
  return isRec(interaction) && Array.isArray(interaction.preprocessor_runs)
    ? interaction.preprocessor_runs
    : []
}

export function trimSearch(interaction: unknown): SearchValue {
  const out: Rec = { preprocessor_runs: runsOf(interaction).map(trimSearchRun).filter(Boolean) }
  if (isRec(interaction)) put(out, "session_id", str(interaction.session_id))
  return out as SearchValue
}

export function trimFetch(interaction: unknown): FetchValue {
  const out: Rec = { preprocessor_runs: runsOf(interaction).map(trimFetchRun).filter(Boolean) }
  if (isRec(interaction)) put(out, "session_id", str(interaction.session_id))
  return out as FetchValue
}

// ---------------------------------------------------------------------------
// Input validation (before any I/O) and the two POSTs.
// ---------------------------------------------------------------------------

/** Trim, drop blanks, reject an empty batch — no dedupe, no count cap (parity). */
export function normalizeQueries(raw: unknown): string[] {
  const queries = (Array.isArray(raw) ? raw : [])
    .map((q) => (typeof q === "string" ? q.trim() : ""))
    .filter(Boolean)
  if (!queries.length) {
    throw new Error("telem_search requires at least one non-empty query in `queries`.")
  }
  return queries
}

export type Wire = { baseUrl: string; apiKey?: string; signal: AbortSignal }

/**
 * ONE POST, never retried (a search bills providers and creates an interaction).
 * `redirect: 'error'` so the bearer credential can never follow a redirect off
 * the configured host. An abort from `signal` propagates as-is so the host's
 * timeout/abort classification stands.
 */
export async function post(op: "search" | "fetch", wire: Wire, body: unknown): Promise<unknown> {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (wire.apiKey) headers.Authorization = `Bearer ${wire.apiKey}`
  const path = op === "search" ? "/v1/interactions" : "/v1/fetch"
  const response = await fetch(`${wire.baseUrl}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: wire.signal,
    redirect: "error",
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    throw new Error(`Telem ${op} failed: HTTP ${response.status} ${detail.slice(0, 200)}`)
  }
  return response.json()
}

export { formatSearchResults, formatFetchResults, validateFetchUrls }
