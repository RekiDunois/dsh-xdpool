/**
 * CodeArts tops out at 65536 output tokens, and it enforces that with an
 * HTTP-200 SSE error frame rather than a 4xx.
 *
 * `max_tokens: options.maxTokens ?? 65536` looks like a default but behaves like
 * "whatever the caller says", and the host does say: the model catalog carries
 * `maxTokens: 384000` for providers whose ceiling really is 384000
 * (deepseek-v4-pro, fireworks, huggingface...). When CodeArts is the provider and
 * the resolved model does not advertise a ceiling of its own, that 384000 goes
 * out verbatim and Huawei answers
 * `HTTP 200` + `data.error_code: "InferHub.4001.200"` + "The request param is
 * invalid, Please check it", which `httpErrorCode()`/`classifyUpstreamError()`
 * turn into an opaque INVALID_REQUEST (or, via the 403 path, "API 密钥无效").
 * A brand-new session sending "你好" fails, which points the finger at the key.
 *
 * Measured against a live endpoint on 2026-10-25 with the failing session's exact
 * system/user prompts and all 133 tools:
 *
 *   max_tokens=384000 -> HTTP 200, SSE error frame InferHub.4001.200, empty reply
 *   max_tokens=131072 -> HTTP 200, empty stream
 *   max_tokens=65536  -> normal streaming reply
 *
 * TRAE and Cline already treat their ceilings the same way
 * (`clampTraeMaxTokens`, `clampClineMaxTokens`) and both also publish the value
 * through `resolved.defaultMaxTokens`, which `catalogFactsFor()` forwards as
 * `fact.maxTokens` so the host can size its own budget. CodeArts did neither.
 *
 * `pack.js` is a build artifact of another repository (`vendor/channel-pack/src`
 * is not even tracked here), so it cannot be imported and driven; source
 * assertions are the only checks that survive the next pack refresh. Same shape
 * as `tests/codearts-resign-headers.test.ts`.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const pack = readFileSync(new URL('../vendor/channel-pack/pack.js', import.meta.url), 'utf8')

const ADAPTER_DECL = 'var CodeArtsAdapter = class extends LlmAdapter {'

/**
 * The whole CodeArtsAdapter, bounded by the next adapter subclass.
 *
 * The bound has to allow the numeric suffix the bundler appends
 * (`LlmAdapter3`, `LlmAdapter4`, ... per import binding), and it must start
 * searching past this declaration's own header, otherwise the anchor matches the
 * very class it is meant to bound and the window collapses to 21 characters.
 */
function codeArtsAdapterWindow(): string {
  const started = pack.indexOf(ADAPTER_DECL)
  expect(started).toBeGreaterThan(-1)
  const rest = pack.slice(started + ADAPTER_DECL.length)
  const nextAdapter = rest.search(/var \w+ = class extends LlmAdapter\d* \{/)
  expect(nextAdapter).toBeGreaterThan(-1)
  return rest.slice(0, nextAdapter)
}

describe('the CodeArts adapter keeps its output ceiling at 65536', () => {
  it('declares the ceiling once, as a named constant', () => {
    // A magic number repeated in three places drifts; the constant is what the
    // model listing, the model facts and the wire request all share. It sits at
    // module scope just above the class, so this one is asserted against the
    // whole pack rather than the adapter window below.
    const decl = 'var CODEARTS_MAX_OUTPUT_TOKENS = 65536;'
    expect(pack.split(decl).length - 1).toBe(1)
  })

  it('advertises the ceiling on every model it lists', () => {
    // listModels() feeds the host's model catalog; without maxTokens here the
    // host has no reason to cap its own 384000.
    const adapter = codeArtsAdapterWindow()
    expect(adapter).toContain('maxTokens: CODEARTS_MAX_OUTPUT_TOKENS,')
  })

  it('reports the ceiling through resolveModel, where the host reads facts', () => {
    // catalogFactsFor() only forwards `fact.maxTokens` when
    // `resolved.defaultMaxTokens` is a positive safe integer.
    const adapter = codeArtsAdapterWindow()
    expect(adapter).toContain('defaultMaxTokens: CODEARTS_MAX_OUTPUT_TOKENS')
  })

  it('clamps the final wire request instead of trusting the caller', () => {
    // This is the actual regression: `options.maxTokens ?? 65536` forwards a
    // caller-supplied 384000 untouched.
    const adapter = codeArtsAdapterWindow()
    expect(adapter).toContain(
      'max_tokens: Math.min(options.maxTokens ?? CODEARTS_MAX_OUTPUT_TOKENS, CODEARTS_MAX_OUTPUT_TOKENS),'
    )
    expect(adapter).not.toContain('max_tokens: options.maxTokens ?? 65536,')
  })

  it('still honours a caller that asks for less than the ceiling', () => {
    // A clamp, not an override: hosts legitimately lower max_tokens for short
    // turns, and Math.min keeps that intact. A plain assignment would not.
    const adapter = codeArtsAdapterWindow()
    const wire = adapter.indexOf('max_tokens: Math.min(')
    expect(wire).toBeGreaterThan(-1)
    expect(adapter.slice(wire, wire + 140)).toContain('options.maxTokens ?? CODEARTS_MAX_OUTPUT_TOKENS')
  })
})
