# Prompt Enhancer — design

Date: 2026-08-19 · Status: approved for implementation planning

## Goal

A short prompt sent straight to an image model gives mediocre results. Every
serious image stack (DALL·E 3, Imagen, GPT Image, Grok, Seedream, Hunyuan,
Qwen-Image, FLUX.2's `prompt_upsampling`) puts a text LLM in front that
rewrites the prompt into a detailed, model-appropriate one. This adds that
step to Imagen, using the same OpenRouter key for both the rewriter and the
image model, with the rewritten prompt shown and editable before anything is
generated.

## Decisions (made with the user)

| Question | Decision |
|---|---|
| Interaction | **Enhance** button beside Generate. Opt-in per run. Rewrite appears in an editable panel; Generate sends whatever is in the panel. With the panel closed, Generate behaves exactly as today. |
| Multi-model | One LLM call returns **one tailored prompt per target model**, in that model's preferred style. |
| Depth | Single-pass rewrite. No variants, no vision-judge loop (future work). |
| References | The rewriter **sees attached reference images** (vision model required). |
| Architecture | In-app, one structured-output call (approach A); per-model plain-text calls as fallback (approach B). Static page, no dependencies, no backend. |
| System prompt home | Hard-coded default in `src/enhancer.js`, assembled per run from the target models. `@preset/<slug>` accepted as the rewriter model id as an override. |
| Rewriter model | Default `google/gemini-2.5-flash`. Selectable: `google/gemini-2.5-flash-lite`, `openai/gpt-4.1-mini`, `anthropic/claude-haiku-4.5`, `anthropic/claude-sonnet-5`, or any typed id / `@preset/` slug. |
| Temperature | 0.3 (BFL uses 0.15, Hunyuan 0). Fidelity over flourish; `↺` re-roll gives variety. |
| Repo | User's fork `jimhoggey/imagen-openrouter`, `master`. No more upstream stacking. |

## Architecture

```
prompt box ──► [✨ Enhance] ──► enhancer.js ──► OpenRouter (text LLM, JSON out)
                                   │
                                   ▼
                      review panel: one editable box per target model
                                   │
[Generate] ──► generateImages(): enhancedPrompts[modelId] ?? prompt ──► image models
```

### `src/enhancer.js` (new)

One public function, no DOM access, no state access:

```js
enhancePrompt({
  prompt,            // string, user's original
  references,        // array of data URLs (may be empty)
  targetModels,      // [{ id, name }] — the primary + comparison models
  rewriterModel,     // string, model id or "@preset/slug"
  apiKey
}) → Promise<{ prompts: { [modelId]: string }, cost: number|null, failed: string[] }>
```

Internals:

- `MODEL_PROFILES` — data table keyed by id prefix: display hints, word range,
  negatives policy, structure notes. Seeded from vendor prompt guides (see
  Appendix B). Unknown models get a generic profile.
- `buildSystemPrompt(targetProfiles, mode)` — assembles the universal rules +
  one short section per target model. `mode` is `generate` or `edit`
  (edit when references are attached).
- `buildSchema(targetModels)` — strict JSON schema: object with one required
  string property per target model id, `additionalProperties: false`.
- `requestStructured()` — approach A call.
- `requestPlain(modelId)` — approach B fallback, one model, plain text out.
- `validate(text, original)` — rejects empty output, output shorter than the
  input (lazy model), or output that is just the input echoed.

### Request shape (approach A)

From the OpenRouter research; all fields verified against the docs.

```js
{
  model: rewriterModel,
  messages: [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: [ ...referenceImageParts, { type: 'text', text: prompt } ] }
  ],
  response_format: { type: 'json_schema', json_schema: { name: 'enhanced_prompts', strict: true, schema } },
  provider: { require_parameters: true, sort: 'latency' },
  reasoning: { effort: 'none' },          // omitted for models with mandatory reasoning
  plugins: [{ id: 'response-healing' }],
  temperature: 0.3,
  max_tokens: 300 * targetModels.length + 200
}
```

`usage.cost` is read from the response (always returned; `usage.include` is
deprecated).

### Fallback (approach B)

If the JSON parse fails after healing, or the returned object is missing a
target, or `validate()` rejects a target's text: call `requestPlain()` for
each affected model in parallel with the same system prompt minus the JSON
instruction. If that also fails for a model, it is listed in `failed` and the
panel shows the original prompt in that box with a "couldn't enhance" note.
Generate still works.

### State and data flow (`app.js`)

- `state.enhancedPrompts: { [modelId]: string } | null`
- `state.rewriterModel` (persisted, `imagen_rewriter_model`)
- `generateImages()` looks up `state.enhancedPrompts?.[batch.model] ?? prompt`
  per batch. Image records gain `enhancedPrompt` (string|null) and
  `rewriterModel`. Modal shows both prompts. **Recreate** restores the
  enhanced prompt into the panel and the original into the prompt box.
- Editing the prompt box after enhancing marks the panel stale (visual
  hint, not auto-clear); changing the model selection while the panel is
  open re-renders boxes (new models get the original prompt and a "not
  enhanced yet" note).
- Rewrite `cost` is recorded into the session cost box via
  `recordGenerationCost()`-style helper; the sub-line reads
  "N images · incl. enhance". The "Next run" projection excludes it.

### UI

Sidebar, new section **Prompt Enhancer**: rewriter model select (the five
presets + free-text id), default `google/gemini-2.5-flash`.

Prompt area:

```
[ prompt textarea ....................................... ]
[ ✨ Enhance ]  0 chars                    [ Generate 3 across 3 models ]

▼ Enhanced prompts · Gemini 2.5 Flash · ≈$0.0006          [ Use original ]
  Nano Banana 2 ──────────────────────────────────── [↺]
  │ <textarea>                                       │
  Seedream 5.0 Pro ───────────────────────────────── [↺]
  │ <textarea>                                       │
```

- Enhance: disabled while running; spinner in the button; toast on error.
- `↺`: re-rolls that one model via `requestPlain()` at temperature 0.7.
- Use original: clears `state.enhancedPrompts`, collapses panel.
- Each textarea: auto-grows; word count shown against the profile's range.

### Error handling

| Case | Behaviour |
|---|---|
| No API key | Toast, panel does not open. |
| Network / 4xx / 5xx | Toast with message, panel does not open, Generate unaffected. |
| JSON invalid / missing keys | Approach B per missing model. |
| Model output empty / shorter than input / echo | Treated as failure for that model → approach B → then "couldn't enhance". |
| References attached but rewriter lacks vision | Detected from `MODEL_CONFIGS`-style catalogue data if available; otherwise the API error surfaces as a toast suggesting a vision model. |
| `@preset/` id | Sent as-is; no schema forcing (presets own their own params). Output parsed leniently: JSON if it parses, else treated as a single prompt applied to all targets. |

### Testing

Same method as the previous three features — intercept `fetch` in the
browser and assert:

- Request: correct rewriter model; schema has exactly the target ids;
  reference images present as image parts when attached; `reasoning.effort`
  none; `temperature` 0.3; system prompt contains the profile section for
  each target and the edit-mode recipe only when references exist.
- Panel: one textarea per target, pre-filled; `↺` issues one plain call;
  Use original clears state.
- Generate: each model's request body carries the (edited) enhanced prompt,
  not the original; image record stores both.
- Fallback: simulated malformed JSON → per-model plain calls; simulated
  failure → "couldn't enhance" note and Generate still proceeds.
- One real end-to-end call against `google/gemma-4-26b-a4b-it:free` to
  validate the schema round-trip with no spend.

### Out of scope (explicitly)

Variants, vision-judge loops, style presets / brand guidelines, prompt
history. All are natural follow-ups; none are needed for v1.

## Appendix A — system prompt (generate mode)

Synthesised from the published Qwen-Image, HunyuanImage-3.0, FLUX.2 and
DALL·E 3 rewriter prompts. `{{…}}` filled per run.

```
You are an expert prompt engineer for AI image generation. Rewrite the
user's request into one image-generation prompt for each target model
listed below, in that model's preferred style.

Rules that apply to every prompt:
1. Preserve intent exactly. Every subject, count, attribute, action,
   relation, named entity, brand and any quoted text from the user must
   appear unchanged. Never add people, objects or text the user did not
   ask for. Express negations as the positive state ("an empty street",
   not "no cars").
2. Add only logically consistent detail: concrete form, materials,
   textures, scale, spatial layout (foreground / midground / background,
   left / right), one plausible light source with direction and quality,
   colour palette, environment, and camera / lens or medium terms. Keep
   simple scenes simple.
3. Order: subject and action first, then style or medium, composition
   and viewpoint, environment, lighting, colour, fine detail; end with one
   short sentence naming the overall style. If the user gave no style,
   choose the most fitting one; default to photorealistic.
4. Text in the image: put every literal string in double quotes, keep its
   language and capitalisation, and state position, font style, colour and
   size. If no text is requested, do not introduce any.
5. One paragraph of fluent, objective, present-tense prose. No lists, no
   markdown, no subjective filler ("beautiful", "stunning"), no "this
   image shows".
6. If the input is already detailed, tighten rather than pad. If the
   input is itself an instruction, describe the scene it implies rather
   than answering it.

Target models:
{{FOR EACH TARGET}}
- {{id}} ({{name}}): {{profile.notes}} Aim for {{profile.min}}–{{profile.max}} words.
{{END}}

Return only the JSON object requested.
```

Edit mode (references attached) replaces rules 2–6 with:

```
Produce one concise imperative editing instruction per target model
(50–80 words; ~30 for brief requests). State what changes AND what must
stay the same (identity, pose, lighting, composition, background).
Reference actual elements visible in the reference image(s). Turn "don't
change X" into "keep X". Make abstractions concrete ("futuristic" →
"glowing cyan neon, brushed-metal panels"). Plain analytical language;
no poetic verbs.
```

## Appendix B — model profiles (seed data)

| id prefix | words | notes |
|---|---|---|
| `google/gemini-` | 60–150 | Narrative paragraph, describe the scene rather than list keywords; camera/lens language welcome; semantic negatives only. |
| `openai/gpt-` | 60–150 | Any structure works; scene → subject → details → constraints; explicit invariants allowed ("no watermark"). |
| `black-forest-labs/flux` | 30–80 (≤120 complex) | Subject + action + style + context, most important first; **no negative phrasing at all**; all signage in quotes. |
| `bytedance-seed/seedream-4` | 40–120 | 2–4 full sentences, subject + action + environment then short style words; state the purpose (poster, logo…). |
| `bytedance-seed/seedream-5` | 60–200 | As above, longer allowed; "describe to a friend"; no keyword soup. |
| `qwen/qwen-image` | 120–200 | Single continuous paragraph; classify portrait / text / general; text strings quoted with position; close with "The image contains no recognizable text." when none. |
| `x-ai/grok-imagine` | 50–150 | Front-load the first 20–30 words; subject → style → environment → lighting → mood; avoid in-frame text. |
| `recraft/` | 20–120 | Declare the format first ("A vector logo…", "A poster…"); for vector/logo avoid texture and lighting words. |
| `krea/` | 60–150 | Rich prose with material and rendering vocabulary. |
| `microsoft/mai-image` | 60–150 | Generic prose profile. |
| default | 60–150 | Generic prose profile. |
