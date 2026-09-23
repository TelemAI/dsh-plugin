// The public check: the bundle builds, imports, and still has the module shape
// DSH's Loader reads. `npm run build` has already run by the time CI calls this.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

const mod = await import("../dist/index.js")

// The default export is the failure worth catching here. DSH's Loader takes
// `exports.default` when it is present and drops the named metadata, so the
// plugin would load, register nothing, and report no error -- exactly the
// silence a build gate exists to break.
assert.equal(mod.default, undefined, "dist/index.js must have NO default export")
assert.equal(mod.name, "telem", 'dist/index.js must export name = "telem"')
assert.deepEqual(mod.inject, ["tools", "systemPrompt"], "dist/index.js must export inject")
assert.equal(typeof mod.Config, "function", "dist/index.js must export the Config schema")
assert.equal(typeof mod.apply, "function", "dist/index.js must export apply")

// The host packages stay external. Inlined, the plugin would run against a
// second copy of cordis and register its tools into nothing: a DSH profile is a
// hoisted pnpm workspace with autoInstallPeers off, so there is one right
// instance and a bundled duplicate is not it.
const bundle = readFileSync(new URL("../dist/index.js", import.meta.url), "utf8")
for (const specifier of ["@deepseek-ai/dsh-tools", "@deepseek-ai/dsh-credentials", "zod"]) {
  assert.ok(bundle.includes(`"${specifier}"`), `${specifier} must remain an external import`)
}

console.log("ok: @telemai/dsh-plugin exports name/inject/Config/apply, no default, DSH packages external")
