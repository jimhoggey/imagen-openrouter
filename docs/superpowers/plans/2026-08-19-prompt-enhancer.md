# Prompt Enhancer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in **Enhance** step that sends the user's prompt (plus any reference images) to a text LLM on OpenRouter and returns one tailored, editable prompt per selected image model before generation.

**Architecture:** A new dependency-free module `src/enhancer.js` owns prompt assembly, the structured-output OpenRouter call, and the per-model fallback; it touches no DOM and no app state. `src/app.js` wires a button, a review panel and a rewriter-model setting around it, and `generateImages()` reads the enhanced prompt per batch. Spec: `docs/superpowers/specs/2026-08-19-prompt-enhancer-design.md`.

**Tech Stack:** Vanilla JS (plain `<script>` tags, no modules, no build), Node 23 built-in `node:test` for unit tests (no npm install), browser `fetch` interception for integration checks.

## Global Constraints

- No new runtime dependencies; no `package.json`, no bundler. `src/enhancer.js` is loaded by a plain `<script>` before `src/app.js`.
- `src/enhancer.js` must be loadable in Node for tests: it ends with `if (typeof module !== 'undefined') module.exports = ImagenEnhancer;` and otherwise exposes `window.ImagenEnhancer`.
- Default rewriter model id: `google/gemini-2.5-flash`. Temperature `0.3` (re-roll `0.7`). Max tokens `300 * targets + 200`.
- Request flags exactly: `response_format` json_schema `strict: true`; `provider: { require_parameters: true, sort: 'latency' }`; `reasoning: { effort: 'none' }`; `plugins: [{ id: 'response-healing' }]`. Do **not** send `usage: { include: true }` (deprecated).
- `@preset/` model ids: send the same messages but **no** `response_format`, `provider`, `reasoning`, `plugins`, or `temperature` (presets own their params); parse leniently.
- Copy: button label `✨ Enhance`, panel title `Enhanced prompts`, collapse button `Use original`, failure note `Couldn't enhance — original prompt will be used`.
- All user-visible strings inserted with `innerHTML` go through `escapeHtml()` (already in `app.js`).
- Code style: 4-space indent, single quotes, JSDoc block comments on exported functions, comments cite the source harness for borrowed prompt text.

---

### Task 1: `src/enhancer.js` — profiles, system prompt, schema, validation (pure functions)

**Files:**
- Create: `src/enhancer.js`
- Create: `tests/enhancer.test.js`

**Interfaces:**
- Produces (global `ImagenEnhancer` / `module.exports`):
  - `MODEL_PROFILES: Array<{ match: string, min: number, max: number, notes: string }>`
  - `getProfile(modelId: string) → { match, min, max, notes }`
  - `buildSystemPrompt(targets: Array<{id: string, name: string}>, mode: 'generate'|'edit') → string`
  - `buildSchema(targets) → object` (JSON schema: `type: 'object'`, one required `string` property per target id, `additionalProperties: false`)
  - `validateOutput(text: unknown, original: string) → string|null` (trimmed text, or `null` if unusable)
  - `DEFAULT_REWRITER_MODEL = 'google/gemini-2.5-flash'`
  - `REWRITER_PRESETS: Array<{ id: string, name: string }>`

- [ ] **Step 1: Write the failing tests**

```js
// tests/enhancer.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/enhancer.js');

const TARGETS = [
    { id: 'google/gemini-3.1-flash-image', name: 'Nano Banana 2' },
    { id: 'black-forest-labs/flux.2-pro', name: 'FLUX.2 Pro' }
];

test('getProfile matches by id prefix and falls back to default', () => {
    assert.equal(E.getProfile('black-forest-labs/flux.2-pro').max, 80);
    assert.equal(E.getProfile('google/gemini-2.5-flash-image').min, 60);
    assert.equal(E.getProfile('some/unknown-model').match, 'default');
});

test('buildSystemPrompt (generate) has universal rules and one line per target', () => {
    const sp = E.buildSystemPrompt(TARGETS, 'generate');
    assert.match(sp, /Preserve intent exactly/);
    assert.match(sp, /google\/gemini-3\.1-flash-image \(Nano Banana 2\)/);
    assert.match(sp, /black-forest-labs\/flux\.2-pro \(FLUX\.2 Pro\)/);
    assert.match(sp, /30–80 words/);            // FLUX profile range
    assert.match(sp, /Return only the JSON object/);
    assert.doesNotMatch(sp, /editing instruction/);
});

test('buildSystemPrompt (edit) swaps in the editing recipe', () => {
    const sp = E.buildSystemPrompt(TARGETS, 'edit');
    assert.match(sp, /editing instruction/);
    assert.match(sp, /keep X/);
    assert.match(sp, /Preserve intent exactly/);   // rule 1 always present
});

test('buildSchema has exactly one required string property per target', () => {
    const s = E.buildSchema(TARGETS);
    assert.equal(s.type, 'object');
    assert.deepEqual(Object.keys(s.properties).sort(), TARGETS.map(t => t.id).sort());
    assert.deepEqual(s.required.sort(), TARGETS.map(t => t.id).sort());
    assert.equal(s.additionalProperties, false);
    for (const p of Object.values(s.properties)) assert.equal(p.type, 'string');
});

test('validateOutput rejects empty, echo, shorter-than-input, non-string', () => {
    const orig = 'a red cube on a table';
    assert.equal(E.validateOutput('', orig), null);
    assert.equal(E.validateOutput('   ', orig), null);
    assert.equal(E.validateOutput(orig, orig), null);
    assert.equal(E.validateOutput('a red cube', orig), null);
    assert.equal(E.validateOutput(42, orig), null);
    assert.equal(E.validateOutput('  A glossy red cube sits on a walnut table, soft window light. ', orig),
        'A glossy red cube sits on a walnut table, soft window light.');
});

test('validateOutput strips wrapping quotes and markdown fences', () => {
    const orig = 'cat';
    assert.equal(E.validateOutput('"A tabby cat sleeps on a sunlit windowsill."', orig),
        'A tabby cat sleeps on a sunlit windowsill.');
    assert.equal(E.validateOutput('```\nA tabby cat sleeps on a sunlit windowsill.\n```', orig),
        'A tabby cat sleeps on a sunlit windowsill.');
});

test('defaults', () => {
    assert.equal(E.DEFAULT_REWRITER_MODEL, 'google/gemini-2.5-flash');
    assert.ok(E.REWRITER_PRESETS.some(p => p.id === 'google/gemini-2.5-flash'));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/`
Expected: FAIL — `Cannot find module '../src/enhancer.js'`

- [ ] **Step 3: Write the implementation**

```js
// src/enhancer.js
/**
 * Imagen — Prompt Enhancer
 *
 * Turns a short user prompt into one detailed, model-appropriate prompt per
 * target image model by asking a text LLM on OpenRouter. Pure module: no DOM,
 * no app state. Loaded by index.html before app.js; also require()-able in
 * Node for tests.
 *
 * The rewrite rules are not invented here. They are synthesised from the
 * published rewriter prompts of:
 *   - Qwen-Image  (src/examples/tools/prompt_utils_2512.py, Apache-2.0)
 *   - HunyuanImage-3.0 (hunyuan_image_3/system_prompt.py)
 *   - FLUX.2 prompt upsampling (src/flux2/system_messages.py, Apache-2.0)
 *   - DALL·E 3 paper appendix (caption upsampler)
 * and the vendor prompting guides for each model family (see MODEL_PROFILES).
 */
const ImagenEnhancer = (() => {
    'use strict';

    const OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';
    const DEFAULT_REWRITER_MODEL = 'google/gemini-2.5-flash';

    /** Offered in the sidebar. Any other id or "@preset/slug" may be typed. */
    const REWRITER_PRESETS = [
        { id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash (default)' },
        { id: 'google/gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite (cheapest)' },
        { id: 'openai/gpt-4.1-mini', name: 'GPT-4.1 Mini' },
        { id: 'anthropic/claude-haiku-4.5', name: 'Claude Haiku 4.5' },
        { id: 'anthropic/claude-sonnet-5', name: 'Claude Sonnet 5 (strongest)' }
    ];

    /**
     * Per-model style hints, matched by id prefix, first match wins. Word
     * ranges and notes come from each vendor's prompting guide.
     */
    const MODEL_PROFILES = [
        { match: 'google/gemini-', min: 60, max: 150,
          notes: 'Write a narrative paragraph that describes the scene rather than listing keywords; camera and lens language is welcome; express exclusions semantically ("an empty street") rather than as negatives.' },
        { match: 'openai/gpt-', min: 60, max: 150,
          notes: 'Any structure works; prefer scene, then subject, then key details, then constraints. Explicit invariants are allowed ("no watermark, no extra text").' },
        { match: 'black-forest-labs/flux', min: 30, max: 80,
          notes: 'Subject + action + style + context, most important first. Never use negative phrasing of any kind — FLUX.2 has no negative prompt. Put all signage and labels in double quotes. Up to 120 words only for genuinely complex scenes.' },
        { match: 'bytedance-seed/seedream-4', min: 40, max: 120,
          notes: 'Two to four full sentences: subject + action + environment, then short style words. State the intended purpose (poster, logo, illustration). Concise beats ornate.' },
        { match: 'bytedance-seed/seedream-5', min: 60, max: 200,
          notes: 'Describe it as you would to a friend, in full sentences; subject, setting, style, lighting, technical in that order. No keyword soup.' },
        { match: 'qwen/qwen-image', min: 120, max: 200,
          notes: 'One continuous paragraph. Treat it as a portrait, a text-containing image, or a general image and describe accordingly. Quote every visible text string with its position, font and colour; if there is none, end with "The image contains no recognizable text."' },
        { match: 'x-ai/grok-imagine', min: 50, max: 150,
          notes: 'Front-load the subject in the first 20–30 words; then style, environment, lighting, mood, technical. Avoid relying on in-frame text.' },
        { match: 'recraft/', min: 20, max: 120,
          notes: 'Declare the format first ("A vector logo of…", "A poster showing…"). For vector and logo work avoid texture and lighting words; for typography name the type system.' },
        { match: 'krea/', min: 60, max: 150,
          notes: 'Rich contextual prose with material and rendering vocabulary; avoid mechanical keyword lists.' },
        { match: 'microsoft/mai-image', min: 60, max: 150,
          notes: 'Clear descriptive prose: subject, setting, style, lighting, composition.' },
        { match: 'default', min: 60, max: 150,
          notes: 'Clear descriptive prose: subject, setting, style, lighting, composition.' }
    ];

    function getProfile(modelId) {
        const id = String(modelId || '');
        return MODEL_PROFILES.find(p => p.match !== 'default' && id.startsWith(p.match))
            || MODEL_PROFILES[MODEL_PROFILES.length - 1];
    }

    // Rule text below is adapted from Qwen-Image prompt_utils_2512.py,
    // HunyuanImage-3.0 en_recaption, and FLUX.2 SYSTEM_MESSAGE_UPSAMPLING_T2I.
    const RULES_COMMON_HEAD =
        'You are an expert prompt engineer for AI image generation. Rewrite the ' +
        'user\'s request into one image-generation prompt for each target model ' +
        'listed below, in that model\'s preferred style.\n\n' +
        'Rules that apply to every prompt:\n' +
        '1. Preserve intent exactly. Every subject, count, attribute, action, ' +
        'relation, named entity, brand and any quoted text from the user must ' +
        'appear unchanged. Never add people, objects or text the user did not ' +
        'ask for. Express negations as the positive state ("an empty street", ' +
        'not "no cars").\n';

    const RULES_GENERATE =
        '2. Add only logically consistent detail: concrete form, materials, ' +
        'textures, scale, spatial layout (foreground / midground / background, ' +
        'left / right), one plausible light source with direction and quality, ' +
        'colour palette, environment, and camera / lens or medium terms. Keep ' +
        'simple scenes simple.\n' +
        '3. Order: subject and action first, then style or medium, composition ' +
        'and viewpoint, environment, lighting, colour, fine detail; end with one ' +
        'short sentence naming the overall style. If the user gave no style, ' +
        'choose the most fitting one; default to photorealistic.\n' +
        '4. Text in the image: put every literal string in double quotes, keep ' +
        'its language and capitalisation, and state position, font style, colour ' +
        'and size. If no text is requested, do not introduce any.\n' +
        '5. One paragraph of fluent, objective, present-tense prose. No lists, ' +
        'no markdown, no subjective filler ("beautiful", "stunning"), no "this ' +
        'image shows".\n' +
        '6. If the input is already detailed, tighten rather than pad. If the ' +
        'input is itself an instruction, describe the scene it implies rather ' +
        'than answering it.\n';

    // Adapted from FLUX.2 SYSTEM_MESSAGE_UPSAMPLING_I2I and Qwen-Image edit
    // templates: edits are one instruction, not a scene description.
    const RULES_EDIT =
        '2. Reference images are attached. Produce one concise imperative ' +
        'editing instruction per target model (50–80 words; about 30 for brief ' +
        'requests). State what changes AND what must stay the same (identity, ' +
        'pose, lighting, composition, background). Reference actual elements ' +
        'visible in the reference image(s). Turn "don\'t change X" into ' +
        '"keep X". Make abstractions concrete ("futuristic" becomes "glowing ' +
        'cyan neon, brushed-metal panels"). Plain analytical language; no ' +
        'poetic verbs, no lists, no markdown.\n';

    /**
     * Assemble the system prompt for a run.
     * @param {Array<{id:string,name:string}>} targets
     * @param {'generate'|'edit'} mode
     */
    function buildSystemPrompt(targets, mode) {
        const rules = mode === 'edit' ? RULES_EDIT : RULES_GENERATE;
        const targetLines = targets.map(t => {
            const p = getProfile(t.id);
            const range = mode === 'edit' ? '' : ` Aim for ${p.min}–${p.max} words.`;
            return `- ${t.id} (${t.name}): ${p.notes}${range}`;
        }).join('\n');

        return RULES_COMMON_HEAD + rules +
            '\nTarget models:\n' + targetLines + '\n\n' +
            'Return only the JSON object requested, with one key per target model id.';
    }

    /** Strict JSON schema: one required string per target model id. */
    function buildSchema(targets) {
        const properties = {};
        targets.forEach(t => {
            properties[t.id] = { type: 'string', description: `Prompt for ${t.name}` };
        });
        return {
            type: 'object',
            properties,
            required: targets.map(t => t.id),
            additionalProperties: false
        };
    }

    /**
     * Clean one model's output and reject useless results (empty, echo of
     * the input, or shorter than the input — a lazy rewrite).
     * @returns {string|null}
     */
    function validateOutput(text, original) {
        if (typeof text !== 'string') return null;
        let t = text.trim();
        // Strip ```fences``` and a single pair of wrapping quotes.
        t = t.replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/, '').trim();
        if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith('“') && t.endsWith('”'))) {
            t = t.slice(1, -1).trim();
        }
        const orig = String(original || '').trim();
        if (!t) return null;
        if (t.toLowerCase() === orig.toLowerCase()) return null;
        if (t.length < orig.length) return null;
        return t;
    }

    return {
        OPENROUTER_CHAT_URL,
        DEFAULT_REWRITER_MODEL,
        REWRITER_PRESETS,
        MODEL_PROFILES,
        getProfile,
        buildSystemPrompt,
        buildSchema,
        validateOutput
    };
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = ImagenEnhancer;
} else if (typeof window !== 'undefined') {
    window.ImagenEnhancer = ImagenEnhancer;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/`
Expected: `# pass 7` / `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add src/enhancer.js tests/enhancer.test.js
git commit -m "feat(enhancer): model profiles, system prompt builder, schema, output validation

Rule text adapted from the published Qwen-Image, HunyuanImage-3.0 and FLUX.2
rewriter prompts; per-model word ranges from vendor prompting guides."
```

---

### Task 2: `enhancePrompt()` — structured call, preset path, per-model fallback

**Files:**
- Modify: `src/enhancer.js` (add inside the IIFE, before `return {...}`; add to the return object)
- Modify: `tests/enhancer.test.js` (append)

**Interfaces:**
- Consumes: Task 1 exports.
- Produces: `enhancePrompt(opts) → Promise<{ prompts: {[id]: string}, cost: number|null, failed: string[], mode: 'generate'|'edit' }>` where `opts = { prompt, references, targetModels, rewriterModel, apiKey, temperature?, fetchImpl? }`. Also `rerollPrompt({ prompt, references, target, rewriterModel, apiKey, fetchImpl? }) → Promise<{ prompt: string|null, cost: number|null }>`.
- `fetchImpl` defaults to `globalThis.fetch`; tests inject a fake.

- [ ] **Step 1: Write the failing tests**

Append to `tests/enhancer.test.js`:

```js
function fakeFetch(handler) {
    const calls = [];
    const fn = async (url, opts) => {
        const body = JSON.parse(opts.body);
        calls.push({ url, headers: opts.headers, body });
        const out = await handler(body, calls.length);
        if (out instanceof Error) throw out;
        return {
            ok: out.status ? out.status < 400 : true,
            status: out.status || 200,
            json: async () => out
        };
    };
    fn.calls = calls;
    return fn;
}

const BASE = {
    prompt: 'a red cube on a table',
    references: [],
    targetModels: TARGETS,
    rewriterModel: 'google/gemini-2.5-flash',
    apiKey: 'test-key'
};

test('enhancePrompt: structured request shape and parsed result', async () => {
    const fetchImpl = fakeFetch(() => ({
        choices: [{ message: { content: JSON.stringify({
            'google/gemini-3.1-flash-image': 'A glossy red cube rests on a walnut table under soft window light, photorealistic.',
            'black-forest-labs/flux.2-pro': 'Red cube on walnut table, soft window light, photoreal.'
        }) } }],
        usage: { cost: 0.00061 }
    }));
    const r = await E.enhancePrompt({ ...BASE, fetchImpl });

    assert.equal(fetchImpl.calls.length, 1);
    const { url, headers, body } = fetchImpl.calls[0];
    assert.equal(url, E.OPENROUTER_CHAT_URL);
    assert.equal(headers.Authorization, 'Bearer test-key');
    assert.equal(body.model, 'google/gemini-2.5-flash');
    assert.equal(body.temperature, 0.3);
    assert.equal(body.max_tokens, 300 * 2 + 200);
    assert.equal(body.response_format.type, 'json_schema');
    assert.equal(body.response_format.json_schema.strict, true);
    assert.deepEqual(Object.keys(body.response_format.json_schema.schema.properties).sort(),
        TARGETS.map(t => t.id).sort());
    assert.deepEqual(body.provider, { require_parameters: true, sort: 'latency' });
    assert.deepEqual(body.reasoning, { effort: 'none' });
    assert.deepEqual(body.plugins, [{ id: 'response-healing' }]);
    assert.equal(body.usage, undefined);
    assert.equal(body.messages[0].role, 'system');
    assert.match(body.messages[0].content, /Target models:/);
    assert.deepEqual(body.messages[1].content, [{ type: 'text', text: 'a red cube on a table' }]);

    assert.equal(r.mode, 'generate');
    assert.equal(r.cost, 0.00061);
    assert.deepEqual(r.failed, []);
    assert.match(r.prompts['black-forest-labs/flux.2-pro'], /walnut/);
});

test('enhancePrompt: references switch to edit mode and are sent as image parts', async () => {
    const fetchImpl = fakeFetch(() => ({
        choices: [{ message: { content: JSON.stringify({
            'google/gemini-3.1-flash-image': 'Keep the subject and lighting; change the cube to blue.',
            'black-forest-labs/flux.2-pro': 'Change the cube to blue, keep table and lighting.'
        }) } }], usage: { cost: 0.001 }
    }));
    const refs = ['data:image/png;base64,AAAA', 'data:image/png;base64,BBBB'];
    const r = await E.enhancePrompt({ ...BASE, prompt: 'make it blue', references: refs, fetchImpl });
    const body = fetchImpl.calls[0].body;
    assert.equal(r.mode, 'edit');
    assert.match(body.messages[0].content, /editing instruction/);
    assert.deepEqual(body.messages[1].content, [
        { type: 'image_url', image_url: { url: refs[0] } },
        { type: 'image_url', image_url: { url: refs[1] } },
        { type: 'text', text: 'make it blue' }
    ]);
});

test('enhancePrompt: missing/invalid keys fall back to one plain call per model', async () => {
    const fetchImpl = fakeFetch((body, n) => {
        if (n === 1) {
            // Structured call: one good, one lazy (echo)
            return { choices: [{ message: { content: JSON.stringify({
                'google/gemini-3.1-flash-image': 'A glossy red cube rests on a walnut table, photorealistic.',
                'black-forest-labs/flux.2-pro': 'a red cube on a table'
            }) } }], usage: { cost: 0.0005 } };
        }
        // Plain fallback for flux
        assert.equal(body.response_format, undefined);
        assert.match(body.messages[0].content, /black-forest-labs\/flux\.2-pro/);
        assert.doesNotMatch(body.messages[0].content, /gemini-3\.1-flash-image/);
        return { choices: [{ message: { content: 'Red cube on a walnut table, soft daylight, photoreal render.' } }],
                 usage: { cost: 0.0002 } };
    });
    const r = await E.enhancePrompt({ ...BASE, fetchImpl });
    assert.equal(fetchImpl.calls.length, 2);
    assert.match(r.prompts['black-forest-labs/flux.2-pro'], /walnut/);
    assert.deepEqual(r.failed, []);
    assert.equal(r.cost, 0.0007);
});

test('enhancePrompt: unparseable JSON → fallback for all; fallback failure → listed in failed', async () => {
    const fetchImpl = fakeFetch((body, n) => {
        if (n === 1) return { choices: [{ message: { content: 'not json at all' } }], usage: { cost: 0.0001 } };
        // only flux gets a usable answer
        if (body.messages[0].content.includes('flux.2-pro')) {
            return { choices: [{ message: { content: 'Red cube on a walnut table, soft daylight, photoreal.' } }], usage: { cost: 0.0002 } };
        }
        return { choices: [{ message: { content: '' } }], usage: { cost: 0.0001 } };
    });
    const r = await E.enhancePrompt({ ...BASE, fetchImpl });
    assert.equal(fetchImpl.calls.length, 3);
    assert.deepEqual(r.failed, ['google/gemini-3.1-flash-image']);
    assert.equal(r.prompts['google/gemini-3.1-flash-image'], undefined);
    assert.match(r.prompts['black-forest-labs/flux.2-pro'], /walnut/);
});

test('enhancePrompt: @preset ids send no forcing params and parse leniently', async () => {
    const fetchImpl = fakeFetch(() => ({
        choices: [{ message: { content: 'A single prompt for everyone, glossy red cube on walnut.' } }], usage: { cost: 0.0003 }
    }));
    const r = await E.enhancePrompt({ ...BASE, rewriterModel: '@preset/my-enhancer', fetchImpl });
    const body = fetchImpl.calls[0].body;
    assert.equal(body.model, '@preset/my-enhancer');
    for (const k of ['response_format', 'provider', 'reasoning', 'plugins', 'temperature']) {
        assert.equal(body[k], undefined, k);
    }
    // Non-JSON preset output is applied to every target
    assert.equal(r.prompts['google/gemini-3.1-flash-image'], r.prompts['black-forest-labs/flux.2-pro']);
    assert.match(r.prompts['black-forest-labs/flux.2-pro'], /walnut/);
});

test('enhancePrompt: HTTP error throws with API message', async () => {
    const fetchImpl = fakeFetch(() => ({ status: 401, error: { message: 'bad key' } }));
    await assert.rejects(E.enhancePrompt({ ...BASE, fetchImpl }), /bad key/);
});

test('rerollPrompt: one plain call at temperature 0.7', async () => {
    const fetchImpl = fakeFetch(() => ({
        choices: [{ message: { content: 'A crimson cube on a pale oak table, morning light, photoreal.' } }], usage: { cost: 0.0002 }
    }));
    const r = await E.rerollPrompt({ prompt: BASE.prompt, references: [], target: TARGETS[1],
        rewriterModel: BASE.rewriterModel, apiKey: 'k', fetchImpl });
    assert.equal(fetchImpl.calls[0].body.temperature, 0.7);
    assert.equal(fetchImpl.calls[0].body.response_format, undefined);
    assert.match(r.prompt, /oak/);
    assert.equal(r.cost, 0.0002);
});
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `node --test tests/`
Expected: 7 pass, 7 fail with `E.enhancePrompt is not a function` / `E.rerollPrompt is not a function`

- [ ] **Step 3: Implement** — insert before `return {` inside the IIFE in `src/enhancer.js`:

```js
    const PLAIN_SUFFIX =
        '\n\nReturn only the prompt text for this single target model. No JSON, no quotes, no commentary.';

    function isPreset(modelId) {
        return String(modelId || '').startsWith('@preset/');
    }

    function buildUserContent(prompt, references) {
        const parts = (references || []).filter(Boolean).map(url => ({
            type: 'image_url', image_url: { url }
        }));
        parts.push({ type: 'text', text: prompt });
        return parts;
    }

    async function postChat(body, apiKey, fetchImpl) {
        const doFetch = fetchImpl || globalThis.fetch;
        const response = await doFetch(OPENROUTER_CHAT_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'X-Title': 'Imagen Prompt Enhancer'
            },
            body: JSON.stringify(body)
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(data?.error?.message || `Enhancer API error: ${response.status}`);
        }
        const content = data?.choices?.[0]?.message?.content;
        const text = Array.isArray(content)
            ? content.map(p => p?.text || '').join('')
            : (content == null ? '' : String(content));
        const cost = Number.isFinite(data?.usage?.cost) ? data.usage.cost : null;
        return { text, cost };
    }

    function tryParseJsonObject(text) {
        if (typeof text !== 'string') return null;
        const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
        try {
            const obj = JSON.parse(cleaned);
            return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
        } catch (e) {
            return null;
        }
    }

    function sumCost(a, b) {
        if (a == null && b == null) return null;
        return (a || 0) + (b || 0);
    }

    /** One plain-text rewrite for a single target (fallback and re-roll). */
    async function requestPlain({ prompt, references, target, rewriterModel, apiKey, temperature, fetchImpl }) {
        const mode = references && references.length ? 'edit' : 'generate';
        const body = {
            model: rewriterModel,
            messages: [
                { role: 'system', content: buildSystemPrompt([target], mode) + PLAIN_SUFFIX },
                { role: 'user', content: buildUserContent(prompt, references) }
            ],
            max_tokens: 500
        };
        if (!isPreset(rewriterModel)) {
            body.temperature = temperature;
            body.provider = { require_parameters: true, sort: 'latency' };
            body.reasoning = { effort: 'none' };
        }
        const { text, cost } = await postChat(body, apiKey, fetchImpl);
        return { prompt: validateOutput(text, prompt), cost };
    }

    /**
     * Rewrite `prompt` once per target model.
     * Structured single call first; per-model plain calls for anything that
     * comes back missing or unusable. Never throws for a bad rewrite — only
     * for transport / auth errors on the first call.
     */
    async function enhancePrompt({ prompt, references, targetModels, rewriterModel, apiKey, temperature = 0.3, fetchImpl }) {
        const targets = (targetModels || []).filter(t => t && t.id);
        const mode = references && references.length ? 'edit' : 'generate';
        const model = rewriterModel || DEFAULT_REWRITER_MODEL;
        const result = { prompts: {}, cost: null, failed: [], mode };
        if (!targets.length) return result;

        const body = {
            model,
            messages: [
                { role: 'system', content: buildSystemPrompt(targets, mode) },
                { role: 'user', content: buildUserContent(prompt, references) }
            ],
            max_tokens: 300 * targets.length + 200
        };
        if (!isPreset(model)) {
            body.temperature = temperature;
            body.response_format = {
                type: 'json_schema',
                json_schema: { name: 'enhanced_prompts', strict: true, schema: buildSchema(targets) }
            };
            body.provider = { require_parameters: true, sort: 'latency' };
            body.reasoning = { effort: 'none' };
            body.plugins = [{ id: 'response-healing' }];
        }

        const first = await postChat(body, apiKey, fetchImpl);
        result.cost = first.cost;

        const parsed = tryParseJsonObject(first.text);
        if (parsed) {
            targets.forEach(t => {
                const clean = validateOutput(parsed[t.id], prompt);
                if (clean) result.prompts[t.id] = clean;
            });
        } else if (isPreset(model)) {
            // A preset may answer with a single prompt; apply it everywhere.
            const clean = validateOutput(first.text, prompt);
            if (clean) targets.forEach(t => { result.prompts[t.id] = clean; });
        }

        const missing = targets.filter(t => !result.prompts[t.id]);
        if (missing.length) {
            const outcomes = await Promise.allSettled(missing.map(target =>
                requestPlain({ prompt, references, target, rewriterModel: model, apiKey, temperature, fetchImpl })
            ));
            outcomes.forEach((o, i) => {
                const t = missing[i];
                if (o.status === 'fulfilled') {
                    result.cost = sumCost(result.cost, o.value.cost);
                    if (o.value.prompt) { result.prompts[t.id] = o.value.prompt; return; }
                }
                result.failed.push(t.id);
            });
        }
        return result;
    }

    /** Re-roll one target with more variety. */
    function rerollPrompt({ prompt, references, target, rewriterModel, apiKey, fetchImpl }) {
        return requestPlain({
            prompt, references, target,
            rewriterModel: rewriterModel || DEFAULT_REWRITER_MODEL,
            apiKey, temperature: 0.7, fetchImpl
        });
    }
```

and extend the return object:

```js
    return {
        OPENROUTER_CHAT_URL,
        DEFAULT_REWRITER_MODEL,
        REWRITER_PRESETS,
        MODEL_PROFILES,
        getProfile,
        buildSystemPrompt,
        buildSchema,
        validateOutput,
        enhancePrompt,
        rerollPrompt
    };
```

- [ ] **Step 4: Run tests**

Run: `node --test tests/`
Expected: `# pass 14` / `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add src/enhancer.js tests/enhancer.test.js
git commit -m "feat(enhancer): enhancePrompt with structured output, preset path and per-model fallback"
```

---

### Task 3: Markup and styles — Enhance button, review panel, rewriter setting

**Files:**
- Modify: `index.html` (script tag ~line 194; prompt area; sidebar before `<!-- Session Cost -->`)
- Modify: `src/styles.css` (append a section before `/* ===== Session Cost ===== */`)

**Interfaces:**
- Produces element ids used by Task 4: `enhanceBtn`, `enhancePanel`, `enhancePanelTitle`, `enhancePanelMeta`, `enhanceList`, `useOriginalBtn`, `rewriterModel` (`<select>`), `rewriterModelCustom` (`<input>`).

- [ ] **Step 1: Load the module before app.js** — change line 194 of `index.html`:

```html
    <script src="src/enhancer.js"></script>
    <script src="src/app.js"></script>
```

- [ ] **Step 2: Replace the prompt area** (`<!-- Prompt Area -->` block) with:

```html
            <!-- Prompt Area -->
            <div class="prompt-area">
                <div class="prompt-container">
                    <textarea id="promptInput" placeholder="Describe the image you want to generate..."
                        rows="3"></textarea>
                    <div class="prompt-actions">
                        <button type="button" class="btn btn-ghost btn-enhance" id="enhanceBtn"
                            title="Rewrite the prompt for each selected model before generating">✨ Enhance</button>
                        <span class="char-count" id="charCount">0 chars</span>
                        <button type="button" class="btn btn-primary" id="generateBtn">
                            Generate
                        </button>
                    </div>
                </div>

                <!-- Enhanced prompts review panel (hidden until Enhance succeeds) -->
                <div class="enhance-panel" id="enhancePanel" hidden>
                    <div class="enhance-panel-header">
                        <span class="enhance-panel-title" id="enhancePanelTitle">Enhanced prompts</span>
                        <span class="enhance-panel-meta" id="enhancePanelMeta"></span>
                        <button type="button" class="btn btn-ghost btn-small" id="useOriginalBtn">Use original</button>
                    </div>
                    <div id="enhanceList"></div>
                </div>
            </div>
```

- [ ] **Step 3: Add the sidebar setting** — insert before `<!-- Session Cost -->` in `index.html`:

```html
            <!-- Prompt Enhancer -->
            <div class="config-section">
                <h3>Prompt Enhancer</h3>
                <select id="rewriterModel" class="text-input select-input" aria-label="Rewriter model">
                    <!-- Populated from ImagenEnhancer.REWRITER_PRESETS at runtime -->
                </select>
                <input type="text" id="rewriterModelCustom" class="text-input" placeholder="custom id or @preset/slug"
                    autocomplete="off" spellcheck="false" hidden>
                <p class="help-text">Rewrites your prompt per model before generating. ≈$0.001 per run.</p>
            </div>
```

- [ ] **Step 4: Styles** — insert before `/* ===== Session Cost ===== */` in `src/styles.css`:

```css
/* ===== Prompt Enhancer ===== */
.btn-enhance {
    margin-right: auto;
}

.btn-enhance.loading {
    opacity: 0.6;
    pointer-events: none;
}

.btn-small {
    padding: 4px 10px;
    font-size: 0.72rem;
}

.select-input {
    appearance: none;
    -webkit-appearance: none;
    background-image: linear-gradient(45deg, transparent 50%, var(--text-muted) 50%),
        linear-gradient(135deg, var(--text-muted) 50%, transparent 50%);
    background-position: calc(100% - 16px) 50%, calc(100% - 11px) 50%;
    background-size: 5px 5px;
    background-repeat: no-repeat;
    padding-right: 32px;
    margin-bottom: 8px;
}

.help-text {
    font-size: 0.7rem;
    color: var(--text-muted);
    margin-top: 6px;
}

.enhance-panel {
    margin-top: 12px;
    background: var(--bg-card);
    border: 1px solid var(--border-color);
    border-radius: var(--border-radius);
    padding: 12px 14px;
}

.enhance-panel.stale {
    border-style: dashed;
}

.enhance-panel-header {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 10px;
}

.enhance-panel-title {
    font-weight: 600;
    font-size: 0.85rem;
    color: var(--text-primary);
}

.enhance-panel-meta {
    font-size: 0.7rem;
    color: var(--text-muted);
    flex: 1;
}

.enhance-item + .enhance-item {
    margin-top: 10px;
}

.enhance-item-head {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 4px;
    font-size: 0.75rem;
    color: var(--text-secondary);
}

.enhance-item-name {
    font-weight: 600;
    color: var(--text-primary);
}

.enhance-item-words {
    margin-left: auto;
    font-variant-numeric: tabular-nums;
    color: var(--text-muted);
}

.enhance-item-words.out-of-range {
    color: var(--warning);
}

.enhance-reroll {
    background: none;
    border: 1px solid var(--border-color);
    border-radius: var(--border-radius-sm);
    color: var(--text-secondary);
    font-family: inherit;
    font-size: 0.75rem;
    width: 24px;
    height: 22px;
    cursor: pointer;
    transition: all var(--transition-fast);
}

.enhance-reroll:hover:not(:disabled) {
    background: var(--bg-hover);
    color: var(--text-primary);
}

.enhance-reroll:disabled {
    opacity: 0.5;
    cursor: default;
}

.enhance-item textarea {
    width: 100%;
    min-height: 64px;
    resize: vertical;
    background: var(--bg-tertiary);
    border: 1px solid var(--border-color);
    border-radius: var(--border-radius-sm);
    color: var(--text-primary);
    font-family: inherit;
    font-size: 0.85rem;
    line-height: 1.45;
    padding: 8px 10px;
    outline: none;
}

.enhance-item textarea:focus {
    border-color: var(--accent-secondary);
}

.enhance-item-note {
    font-size: 0.72rem;
    color: var(--warning);
    margin-top: 4px;
}

```

- [ ] **Step 5: Verify markup renders** — `preview_start` the `imagen` server (already configured), reload `http://localhost:8347`, screenshot: Enhance button appears left of the char count, panel is hidden, sidebar has a "Prompt Enhancer" section with an empty select. No console errors (the select is populated in Task 4).

- [ ] **Step 6: Commit**

```bash
git add index.html src/styles.css
git commit -m "feat(enhancer): Enhance button, review panel and rewriter setting markup/styles"
```

---

### Task 4: Wire it into `app.js` — state, handlers, generation, metadata, cost

**Files:**
- Modify: `src/app.js`:
  - `const state = {` (~line 90): add fields
  - `const elements = {` (~line 367): add refs
  - after `updateSessionCostUI()` (~line 469–493): add enhancer section (new functions)
  - `init()` (~line 660): populate select, restore setting
  - `setupEventListeners()` (~line 714): new listeners; prompt input marks panel stale
  - `generateImages()` (~line 1056): per-batch prompt lookup, image record fields
  - `openModal()` (~line 1719): show enhanced prompt
  - `recreateImage()` (~line 1747) and `recreateImageByIndex()` (~line 1674): restore enhanced prompt
- Modify: `README.md` (feature section)

**Interfaces:**
- Consumes: `window.ImagenEnhancer` from Tasks 1–2; element ids from Task 3; existing `getActiveModelIds()`, `MODEL_CONFIGS`, `recordGenerationCost()`-style cost helpers, `showToast()`, `escapeHtml()`, `selectModel()`.
- Produces: `state.enhancedPrompts`, `state.rewriterModel`, `runEnhance()`, `renderEnhancePanel()`, `clearEnhancedPrompts()`, `markEnhancePanelStale()`, `getRewriterModel()`, image record fields `enhancedPrompt`, `rewriterModel`.

- [ ] **Step 1: State** — in `const state = {`, after `sessionCost: ...` add:

```js
    // Prompt enhancer. enhancedPrompts is null when the review panel is
    // closed; otherwise { [imageModelId]: text } and Generate sends these.
    enhancedPrompts: null,
    enhanceFailed: [],            // image model ids the rewriter could not handle
    enhancePromptSource: '',      // the user prompt the panel was built from
    rewriterModel: localStorage.getItem('imagen_rewriter_model') || ImagenEnhancer.DEFAULT_REWRITER_MODEL,
```

- [ ] **Step 2: Elements** — in `const elements = {`, after `resetSessionCost: ...` add:

```js
    enhanceBtn: document.getElementById('enhanceBtn'),
    enhancePanel: document.getElementById('enhancePanel'),
    enhancePanelMeta: document.getElementById('enhancePanelMeta'),
    enhanceList: document.getElementById('enhanceList'),
    useOriginalBtn: document.getElementById('useOriginalBtn'),
    rewriterModel: document.getElementById('rewriterModel'),
    rewriterModelCustom: document.getElementById('rewriterModelCustom'),
```

- [ ] **Step 3: Enhancer section** — insert immediately after the `updateSessionCostUI()` function (before `// ===== Model Picker =====`):

```js
// ===== Prompt Enhancer =====
const REWRITER_CUSTOM_VALUE = '__custom__';

/** Current rewriter id: a preset from the select, or the custom text field. */
function getRewriterModel() {
    return state.rewriterModel || ImagenEnhancer.DEFAULT_REWRITER_MODEL;
}

function populateRewriterSelect() {
    if (!elements.rewriterModel) return;
    const presets = ImagenEnhancer.REWRITER_PRESETS;
    const isPreset = presets.some(p => p.id === state.rewriterModel);
    elements.rewriterModel.innerHTML = presets.map(p =>
        `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`
    ).join('') + `<option value="${REWRITER_CUSTOM_VALUE}">Custom id / @preset…</option>`;
    elements.rewriterModel.value = isPreset ? state.rewriterModel : REWRITER_CUSTOM_VALUE;
    elements.rewriterModelCustom.hidden = isPreset;
    if (!isPreset) elements.rewriterModelCustom.value = state.rewriterModel;
}

function setRewriterModel(id) {
    const clean = String(id || '').trim();
    if (!clean) return;
    state.rewriterModel = clean;
    localStorage.setItem('imagen_rewriter_model', clean);
}

function countWords(text) {
    return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

/** Record rewrite spend into the session cost box. */
function recordEnhanceCost(cost) {
    if (!Number.isFinite(cost) || cost <= 0) return;
    state.sessionCost.total += cost;
    state.sessionCost.enhanceCalls = (state.sessionCost.enhanceCalls || 0) + 1;
    persistSessionCost();
    updateSessionCostUI();
}

function clearEnhancedPrompts() {
    state.enhancedPrompts = null;
    state.enhanceFailed = [];
    state.enhancePromptSource = '';
    elements.enhancePanel.hidden = true;
    elements.enhancePanel.classList.remove('stale');
    elements.enhanceList.innerHTML = '';
}

/** The prompt box changed after enhancing: hint, but keep the panel. */
function markEnhancePanelStale() {
    if (!state.enhancedPrompts) return;
    const current = elements.promptInput.value.trim();
    elements.enhancePanel.classList.toggle('stale', current !== state.enhancePromptSource);
}

/** One editable box per active image model, pre-filled from state. */
function renderEnhancePanel() {
    if (!state.enhancedPrompts) { elements.enhancePanel.hidden = true; return; }

    const models = getActiveModelIds().filter(id => MODEL_CONFIGS[id]);
    elements.enhanceList.innerHTML = models.map(id => {
        const config = MODEL_CONFIGS[id];
        const profile = ImagenEnhancer.getProfile(id);
        const text = state.enhancedPrompts[id];
        const failed = state.enhanceFailed.includes(id);
        const value = text != null ? text : state.enhancePromptSource;
        const words = countWords(value);
        const outOfRange = words < profile.min || words > profile.max;
        const note = failed
            ? 'Couldn\'t enhance — original prompt will be used'
            : (text == null ? 'Not enhanced yet — press ✨ Enhance again or edit by hand' : '');
        return `
            <div class="enhance-item" data-model="${escapeHtml(id)}">
                <div class="enhance-item-head">
                    <span class="enhance-item-name">${escapeHtml(config.name)}</span>
                    <span class="model-option-id">${escapeHtml(id)}</span>
                    <span class="enhance-item-words${outOfRange ? ' out-of-range' : ''}"
                          title="Suggested ${profile.min}–${profile.max} words">${words} words</span>
                    <button type="button" class="enhance-reroll" data-reroll="${escapeHtml(id)}"
                        title="Re-roll this prompt">↺</button>
                </div>
                <textarea data-enhanced="${escapeHtml(id)}" rows="3">${escapeHtml(value)}</textarea>
                ${note ? `<div class="enhance-item-note">${escapeHtml(note)}</div>` : ''}
            </div>`;
    }).join('');
    elements.enhancePanel.hidden = false;
}

/** Enhance button handler. */
async function runEnhance() {
    const prompt = elements.promptInput.value.trim();
    if (!prompt) { showToast('Please enter a prompt', 'warning'); return; }
    if (!state.apiKey) { showToast('Please enter your OpenRouter API key', 'error'); return; }

    const targetModels = getActiveModelIds()
        .filter(id => MODEL_CONFIGS[id])
        .map(id => ({ id, name: MODEL_CONFIGS[id].name }));
    if (!targetModels.length) { showToast('Select an image model first', 'warning'); return; }

    elements.enhanceBtn.classList.add('loading');
    elements.enhanceBtn.textContent = 'Enhancing…';
    try {
        const result = await ImagenEnhancer.enhancePrompt({
            prompt,
            references: state.references.filter(Boolean),
            targetModels,
            rewriterModel: getRewriterModel(),
            apiKey: state.apiKey
        });
        recordEnhanceCost(result.cost);
        state.enhancedPrompts = result.prompts;
        state.enhanceFailed = result.failed;
        state.enhancePromptSource = prompt;
        elements.enhancePanelMeta.textContent =
            `${getRewriterModel()} · ${result.mode === 'edit' ? 'edit mode' : 'generate mode'}` +
            (Number.isFinite(result.cost) ? ` · ${formatCost(result.cost)}` : '');
        renderEnhancePanel();
        elements.enhancePanel.classList.remove('stale');
        if (result.failed.length) {
            showToast(`Couldn't enhance for ${result.failed.length} model(s) — original will be used there`, 'warning');
        } else {
            showToast('Prompts enhanced — review, edit, then Generate', 'success');
        }
    } catch (error) {
        console.error('Enhance failed:', error);
        showToast(`Enhance failed: ${error.message}`, 'error');
    } finally {
        elements.enhanceBtn.classList.remove('loading');
        elements.enhanceBtn.textContent = '✨ Enhance';
    }
}

/** ↺ on one model. */
async function rerollEnhanced(modelId, button) {
    if (!state.enhancedPrompts || !MODEL_CONFIGS[modelId]) return;
    button.disabled = true;
    try {
        const { prompt: text, cost } = await ImagenEnhancer.rerollPrompt({
            prompt: state.enhancePromptSource,
            references: state.references.filter(Boolean),
            target: { id: modelId, name: MODEL_CONFIGS[modelId].name },
            rewriterModel: getRewriterModel(),
            apiKey: state.apiKey
        });
        recordEnhanceCost(cost);
        if (text) {
            state.enhancedPrompts[modelId] = text;
            state.enhanceFailed = state.enhanceFailed.filter(id => id !== modelId);
            renderEnhancePanel();
        } else {
            showToast('Re-roll returned nothing usable', 'warning');
        }
    } catch (error) {
        showToast(`Re-roll failed: ${error.message}`, 'error');
    } finally {
        button.disabled = false;
    }
}

/** Read the (possibly edited) text for a model at Generate time. */
function getPromptForModel(modelId, fallback) {
    if (!state.enhancedPrompts) return fallback;
    const box = elements.enhanceList.querySelector(`textarea[data-enhanced="${CSS.escape(modelId)}"]`);
    const text = box ? box.value.trim() : (state.enhancedPrompts[modelId] || '');
    return text || fallback;
}

```

- [ ] **Step 4: init()** — after `updateSessionCostUI();` at the end of `init()`, add:

```js
    populateRewriterSelect();
```

- [ ] **Step 5: Listeners** — in `setupEventListeners()`, before `// Manual catalogue refresh (bypasses the 24h cache)` add:

```js
    // Prompt enhancer
    elements.enhanceBtn.addEventListener('click', runEnhance);
    elements.useOriginalBtn.addEventListener('click', () => {
        clearEnhancedPrompts();
        showToast('Using original prompt', 'info');
    });
    elements.enhanceList.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-reroll]');
        if (btn) rerollEnhanced(btn.dataset.reroll, btn);
    });
    elements.enhanceList.addEventListener('input', (e) => {
        const box = e.target.closest('textarea[data-enhanced]');
        if (!box) return;
        const id = box.dataset.enhanced;
        state.enhancedPrompts[id] = box.value;
        const profile = ImagenEnhancer.getProfile(id);
        const words = countWords(box.value);
        const counter = box.parentElement.querySelector('.enhance-item-words');
        if (counter) {
            counter.textContent = `${words} words`;
            counter.classList.toggle('out-of-range', words < profile.min || words > profile.max);
        }
    });
    elements.promptInput.addEventListener('input', markEnhancePanelStale);
    elements.rewriterModel.addEventListener('change', () => {
        const v = elements.rewriterModel.value;
        if (v === REWRITER_CUSTOM_VALUE) {
            elements.rewriterModelCustom.hidden = false;
            elements.rewriterModelCustom.focus();
        } else {
            elements.rewriterModelCustom.hidden = true;
            setRewriterModel(v);
        }
    });
    elements.rewriterModelCustom.addEventListener('change', () => {
        setRewriterModel(elements.rewriterModelCustom.value);
    });
```

Also: where `toggleComparisonModel()` and `selectModel()` end (they call `updateModelSummary()`), the panel must re-render so new models get a box. Add one line inside `updateModelSummary()` at its end:

```js
    renderEnhancePanel();
```

(`renderEnhancePanel()` is a no-op when `state.enhancedPrompts` is null.)

- [ ] **Step 6: generateImages()** — three edits:

(a) After the `targetModels` check, capture original once:
```js
    const originalPrompt = prompt;
```

(b) In the `batches` map, set the batch prompt per model:
```js
        const batch = {
            id: Date.now() + Math.random(),
            prompt: getPromptForModel(modelId, originalPrompt),
            originalPrompt: originalPrompt,
            model: modelId,
```

(c) In `generateAndDisplay`, use `batch.prompt` and record both:
```js
            const result = await generateSingleImage(batch.prompt, batch.model, modelConfig, meta);
            if (result) {
                recordGenerationCost(meta, modelConfig);
                const imageData = {
                    id: Date.now() + index + Math.random(),
                    url: result,
                    prompt: batch.originalPrompt,
                    enhancedPrompt: batch.prompt !== batch.originalPrompt ? batch.prompt : null,
                    rewriterModel: batch.prompt !== batch.originalPrompt ? getRewriterModel() : null,
                    model: batch.model,
```

- [ ] **Step 7: openModal()** — after the `<p><strong>Prompt:</strong> …</p>` line add:

```js
        ${image.enhancedPrompt ? `<p><strong>Enhanced prompt:</strong> ${escapeHtml(image.enhancedPrompt)}</p>
        <p><strong>Rewriter:</strong> ${escapeHtml(image.rewriterModel || '')}</p>` : ''}
```

- [ ] **Step 8: recreateImage() and recreateImageByIndex()** — in both, right after the prompt box is restored (`elements.promptInput.value = …; elements.charCount.textContent = …;`), add:

```js
    // Restore the enhanced prompt into the review panel for this model, so
    // Generate replays what actually produced the image.
    clearEnhancedPrompts();
    if (IMG.enhancedPrompt) {
        state.enhancedPrompts = { [IMG.model]: IMG.enhancedPrompt };
        state.enhancePromptSource = IMG.prompt;
        elements.enhancePanelMeta.textContent = `${IMG.rewriterModel || 'enhanced'} · restored`;
    }
```

where `IMG` is `state.currentImage` in `recreateImage()` and `image` in `recreateImageByIndex()`. Both functions end by calling `selectModel(...)`, which calls `updateModelSummary()` → `renderEnhancePanel()`, so the panel appears after the model is restored.

- [ ] **Step 9: Session cost subtext** — in `updateSessionCostUI()`, change the `sessionCostSub` line to:

```js
    const enhances = state.sessionCost.enhanceCalls || 0;
    elements.sessionCostSub.textContent = images
        ? `${images} image${images === 1 ? '' : 's'} this session${enhances ? ' · incl. enhance' : ''}`
        : (enhances ? `${enhances} enhance call${enhances === 1 ? '' : 's'}, no images yet` : 'No images yet');
```

and in `resetSessionCost()` the fresh object gains `enhanceCalls: 0`.

- [ ] **Step 10: README** — insert before `### 📐 Flexible Output Options`:

```markdown
### ✨ Prompt Enhancer
Short prompts give mediocre images. **Enhance** sends your prompt (and any
reference images) to a text LLM on OpenRouter, which rewrites it into one
detailed prompt **per selected image model**, in that model's preferred style.

- Review and edit each rewritten prompt before anything is generated
- ↺ re-rolls a single model's prompt; **Use original** drops the rewrite
- With reference images attached it switches to edit-instruction mode
- Default rewriter `google/gemini-2.5-flash` (≈$0.001 per run); switch to
  GPT-4.1 Mini, Claude Haiku/Sonnet, any model id, or an OpenRouter
  `@preset/` in the sidebar
- The rewrite rules are adapted from the published Qwen-Image, HunyuanImage
  and FLUX.2 rewriter prompts, not invented here

```

- [ ] **Step 11: Syntax check and unit tests**

Run: `node --check src/app.js && node --test tests/`
Expected: no output from `--check`; `# pass 14`.

- [ ] **Step 12: Commit**

```bash
git add src/app.js README.md
git commit -m "feat(enhancer): wire Enhance button, review panel, rewriter setting and per-model generation"
```

---

### Task 5: Browser verification (intercepted fetch) and one real free-tier call

**Files:** none (verification only; fix anything found, then commit fixes with `fix(enhancer): …`).

- [ ] **Step 1: Start preview** — `preview_start` name `imagen`; navigate to `http://localhost:8347`; `localStorage.clear()` then reload. Check `read_console_messages` → no errors. Check the sidebar select shows 5 presets + Custom, value `google/gemini-2.5-flash`.

- [ ] **Step 2: Intercepted enhance → panel → generate** — run in `javascript_tool`:

```js
(async () => {
  await initModelPicker(true);
  selectModel('google/gemini-2.5-flash-image');
  state.comparisonModels = []; toggleComparisonModel('black-forest-labs/flux.2-pro');
  state.apiKey = 'k'; state.imageCount = 1;
  elements.promptInput.value = 'a red cube on a table';
  const seen = []; const real = window.fetch;
  window.fetch = async (u, o) => {
    const b = JSON.parse(o.body); seen.push(b);
    if (b.response_format) return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({
      'google/gemini-2.5-flash-image': 'A glossy red cube rests on a walnut table under soft window light, photorealistic.',
      'black-forest-labs/flux.2-pro': 'Red cube on walnut table, soft window light, photoreal.' }) } }], usage: { cost: 0.0006 } }) };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { images: [{ image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } }] } }], usage: { cost: 0.04 } }) };
  };
  await runEnhance();
  const boxes = [...document.querySelectorAll('#enhanceList textarea')];
  boxes[1].value = 'EDITED flux prompt on walnut table'; boxes[1].dispatchEvent(new Event('input', { bubbles: true }));
  await generateImages();
  window.fetch = real;
  const out = {
    enhanceReq: { model: seen[0].model, temp: seen[0].temperature, keys: Object.keys(seen[0].response_format.json_schema.schema.properties), reasoning: seen[0].reasoning, plugins: seen[0].plugins },
    panelBoxes: boxes.length, panelHidden: elements.enhancePanel.hidden,
    genPrompts: seen.slice(1).map(b => [b.model, typeof b.messages[0].content === 'string' ? b.messages[0].content : b.messages[0].content.find(p => p.type === 'text').text]),
    records: state.images.slice(0, 2).map(i => ({ m: i.model, p: i.prompt, e: i.enhancedPrompt })),
    cost: elements.sessionCostTotal.textContent, sub: elements.sessionCostSub.textContent
  };
  await ImagenDB.clearAll(); state.images = []; renderGallery();
  return JSON.stringify(out, null, 1);
})()
```

Expected: `enhanceReq.model` = `google/gemini-2.5-flash`, `temp` 0.3, `keys` = the two ids, `reasoning` `{effort:'none'}`, `plugins` response-healing; `panelBoxes` 2; `genPrompts` shows the Gemini request carrying the walnut prose and the FLUX request carrying `EDITED flux prompt on walnut table`; `records[*].p` = original, `.e` = enhanced; cost `$0.08` with sub `2 images this session · incl. enhance`.

- [ ] **Step 3: Edit mode + fallback + use-original** — in `javascript_tool`:

```js
(async () => {
  state.references = ['data:image/png;base64,AAAA'];
  const seen = []; const real = window.fetch;
  window.fetch = async (u, o) => { const b = JSON.parse(o.body); seen.push(b);
    if (b.response_format) return { ok: true, json: async () => ({ choices: [{ message: { content: 'garbage' } }], usage: { cost: 0.0001 } }) };
    return { ok: true, json: async () => ({ choices: [{ message: { content: b.messages[0].content.includes('flux') ? 'Keep the table and light; change the cube to blue, matte finish.' : '' } }], usage: { cost: 0.0001 } }) }; };
  elements.promptInput.value = 'make it blue';
  await runEnhance(); window.fetch = real;
  const out = { mode: /editing instruction/.test(seen[0].messages[0].content), imgParts: seen[0].messages[1].content.filter(p => p.type === 'image_url').length,
    calls: seen.length, failed: state.enhanceFailed, notes: [...document.querySelectorAll('.enhance-item-note')].map(n => n.textContent) };
  elements.useOriginalBtn.click();
  out.afterUseOriginal = { hidden: elements.enhancePanel.hidden, enhanced: state.enhancedPrompts };
  state.references = []; renderReferenceSlots();
  return JSON.stringify(out, null, 1);
})()
```

Expected: `mode` true, `imgParts` 1, `calls` 3, `failed` = `['google/gemini-2.5-flash-image']`, one note `Couldn't enhance — original prompt will be used`; after Use original: `hidden` true, `enhanced` null.

- [ ] **Step 4: Stale marking and model-change re-render** — type in the prompt box after an enhance (dispatch `input`) → `enhancePanel.classList.contains('stale')` true; add a comparison model → a third box appears with the "Not enhanced yet" note.

- [ ] **Step 5: One real end-to-end call, no spend** — with a valid key in `state.apiKey` (ask the user to paste one into the sidebar if none is saved), set the custom rewriter id to `google/gemma-4-26b-a4b-it:free`, prompt `a lighthouse at dusk`, primary Gemini + FLUX, press Enhance in the UI. Expected: panel shows two different prose prompts, word counts within range, meta shows the model and a `$0.00` cost. Screenshot it. Then set the rewriter back to the default preset.

- [ ] **Step 6: Commit any fixes; push**

```bash
git push fork master
```

---

## Self-review

**Spec coverage:** Enhance button + opt-in (T3/T4) ✓ · per-model tailored prompts via one structured call (T1/T2) ✓ · fallback B (T2) ✓ · references → edit mode + vision parts (T2) ✓ · `@preset/` (T2/T4) ✓ · rewriter model setting with defaults (T1/T3/T4) ✓ · temp 0.3 / re-roll 0.7 (T2) ✓ · panel: per-model boxes, ↺, Use original, stale hint, re-render on model change, word count vs profile (T4) ✓ · Generate reads edited text (T4 step 6) ✓ · image record stores both + modal shows both + Recreate restores (T4 steps 6–8) ✓ · cost into session box, projection excluded (T4 steps 3/9) ✓ · error cases table: no key / HTTP / bad JSON / lazy output / preset lenient (T2/T4) ✓; "rewriter lacks vision" handled as the API-error toast path ✓ · tests as specified (T1/T2 unit, T5 browser + real free call) ✓ · no deps / static (global constraints) ✓.

**Placeholders:** none — every step has the code.

**Type consistency:** `enhancePrompt` returns `{ prompts, cost, failed, mode }` in T2 and is consumed identically in T4 `runEnhance()`; `rerollPrompt` returns `{ prompt, cost }` in T2 and T4 `rerollEnhanced()`; `getProfile` → `{ match, min, max, notes }` used by T4 word counter; element ids in T3 match T4 `elements`; `state.sessionCost.enhanceCalls` added in T4 step 3 and read in step 9.
