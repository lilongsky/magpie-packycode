// What the plugin does when the console is rate limited by Cloudflare (1015):
// the last price list on disk keeps routing, and the keys already made keep
// working without asking the token list whether they are still there.

import { test, afterEach } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { PRICING } from "./fake.mjs"
import { World } from "../src/world.mjs"
import { buildCatalog } from "../src/catalog.mjs"
import { orderFor } from "../src/router.mjs"
import { signInError } from "../src/request.mjs"
import { saveMade } from "../src/keys.mjs"
import { loadSnapshot, saveSnapshot } from "../src/snapshot.mjs"

const dirs = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

const dir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "packycode-resilience-"))
  dirs.push(d)
  return d
}

const auth = { type: "api", key: "tok-0123456789abcdef", metadata: { mode: "token", userID: "12345", endpoint: "slb" } }
const offline = async () => {
  const e = new Error("www.packyapi.com answered 429: error code: 1015")
  e.status = 429
  throw e
}

test("a rate-limited console still prices from the last list it answered", async () => {
  const d = dir()
  saveSnapshot(d, PRICING, { data: { quota_per_unit: 500000, price: 1 } })
  const w = new World(auth, {}, offline, d)
  const pricing = await w.pricing()
  assert.ok(pricing.models.size > 0, "models came from the snapshot")
  assert.ok(pricing.models.has("claude-x"))
})

test("the keys already made keep working when the token list cannot be read", async () => {
  const d = dir()
  saveMade(d, { cheap: { id: 7, key: "sk-cheap-aaaaaaaaaaaaaaaaa", name: "magpie-cheap" } })
  const w = new World(auth, {}, offline, d)
  const keys = await w.keys()
  assert.equal(keys.length, 1)
  assert.equal(keys[0].key, "sk-cheap-aaaaaaaaaaaaaaaaa")
  assert.deepEqual(keys[0].groups, ["cheap"])
})

test("no price list anywhere is an error, not an empty picker", async () => {
  const d = dir()
  const w = new World(auth, {}, offline, d)
  await assert.rejects(() => w.pricing(), /429|1015/)
})

test("a fresh snapshot preserves Grok's group protocol and price chip through an outage", async () => {
  const d = dir()
  const model = "grok-4.7"
  const raw = {
    group_ratio: { "grok-sale": 0.3, "grok-officially": 1 },
    model_group_endpoints: { "grok-sale": { [model]: ["openai-response"] } },
    data: [{ model_name: model, model_ratio: 1, completion_ratio: 3, enable_groups: ["grok-sale", "grok-officially"], supported_endpoint_types: ["openai", "openai-response"] }],
  }
  saveMade(d, { "grok-sale": { id: 7, key: "sk-test-grok-resilience-key", name: "magpie-grok-sale" } })
  const fresh = new World({ metadata: { mode: "keys", endpoint: "cf", consoleEndpoint: "ai" } }, {}, async (url) => {
    assert.equal(new URL(url).origin, "https://www.packyapi.ai")
    const data = new URL(url).pathname === "/api/status" ? { data: { quota_per_unit: 500000, price: 1 } } : raw
    return new Response(JSON.stringify(data))
  }, d)
  await fresh.pricing()
  assert.deepEqual(loadSnapshot(d).raw.model_group_endpoints, raw.model_group_endpoints)

  const resumed = new World(auth, {}, offline, d)
  const pricing = await resumed.pricing()
  const keys = await resumed.keys()
  const catalog = buildCatalog({ pricing, keys })
  assert.equal(catalog[model].api.npm, "@ai-sdk/openai")
  assert.equal(catalog[model].cost.input, 0.6)
  assert.equal(catalog[model].rate, 0.3)
  assert.equal(catalog[model].rateWas, 1)
  assert.deepEqual(orderFor({ model, keys, pricing, endpoint: "openai" }), [])
  assert.equal(orderFor({ model, keys, pricing, endpoint: "openai-response" })[0].group, "grok-sale")
})

for (const status of [401, 403]) {
  test(`a refused system token (${status}) is not hidden by saved relay keys`, async () => {
    const d = dir()
    saveMade(d, { "grok-sale": { id: 7, key: "sk-test-grok-resilience-key", name: "magpie-grok-sale" } })
    const file = path.join(d, "packycode-keys.json")
    const before = fs.readFileSync(file, "utf8")
    const w = new World(auth, {}, async (_url, init) => {
      assert.equal(init.method, "GET")
      return new Response("sign in again", { status })
    }, d)
    await assert.rejects(() => w.keys(), (error) => signInError(error).signIn === "expired" && error.message.includes(String(status)))
    assert.equal(fs.readFileSync(file, "utf8"), before)
  })
}

test("an empty price list reports the independently selected console setting", async () => {
  const d = dir()
  const w = new World({ metadata: { mode: "keys", endpoint: "cf", consoleEndpoint: "ai" } }, {}, async () => new Response(JSON.stringify({ data: [] })), d)
  await assert.rejects(() => w.pricing(), (error) => /www\.packyapi\.ai/.test(error.message) && /配置调用接口/.test(error.message))
  assert.equal(loadSnapshot(d), null)
})
