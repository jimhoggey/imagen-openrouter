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

    const CLOSER_JSON =
        'Return only the JSON object requested, with one key per target model id.';
    const CLOSER_PLAIN =
        'Return only the prompt text for this single target model. No JSON, no quotes, no commentary.';

    /**
     * Assemble the system prompt for a run.
     * @param {Array<{id:string,name:string}>} targets
     * @param {'generate'|'edit'} mode
     * @param {'json'|'plain'} [format] 'json' for the structured multi-target
     *   call, 'plain' for a single-target prose call.
     */
    function buildSystemPrompt(targets, mode, format = 'json') {
        const rules = mode === 'edit' ? RULES_EDIT : RULES_GENERATE;
        const targetLines = targets.map(t => {
            const p = getProfile(t.id);
            const range = mode === 'edit' ? '' : ` Aim for ${p.min}–${p.max} words.`;
            return `- ${t.id} (${t.name}): ${p.notes}${range}`;
        }).join('\n');

        return RULES_COMMON_HEAD + rules +
            '\nTarget models:\n' + targetLines + '\n\n' +
            (format === 'plain' ? CLOSER_PLAIN : CLOSER_JSON);
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

    /** Strip a leading ```fence (with optional language) and its closer. */
    function stripFences(text) {
        return String(text == null ? '' : text).trim()
            .replace(/^```[a-z]*\s*/i, '')
            .replace(/\s*```$/, '')
            .trim();
    }

    /** Whitespace-separated token count. */
    function countWords(s) {
        const words = String(s == null ? '' : s).trim().match(/\S+/g);
        return words ? words.length : 0;
    }

    /**
     * Clean one model's output and reject useless results (empty, or an echo
     * of the input). A short input must be expanded; a detailed input (25+
     * words) may legitimately be tightened, which the system prompt asks for.
     * @returns {string|null}
     */
    function validateOutput(text, original) {
        if (typeof text !== 'string') return null;
        // Strip ```fences``` and a single pair of wrapping quotes.
        let t = stripFences(text);
        if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith('“') && t.endsWith('”'))) {
            t = t.slice(1, -1).trim();
        }
        const orig = String(original || '').trim();
        if (!t) return null;
        if (t.toLowerCase() === orig.toLowerCase()) return null;
        const origWords = countWords(orig);
        if (origWords < 25 && countWords(t) < origWords) return null;
        return t;
    }

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
        const cleaned = stripFences(text);
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
                { role: 'system', content: buildSystemPrompt([target], mode, 'plain') },
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
        // Some rewriters answer with JSON anyway; unwrap it rather than fail.
        let out = text;
        const obj = tryParseJsonObject(out);
        if (obj) {
            out = typeof obj[target.id] === 'string'
                ? obj[target.id]
                : (Object.values(obj).find(v => typeof v === 'string') || '');
        }
        return { prompt: validateOutput(out, prompt), cost };
    }

    /**
     * Rewrite `prompt` once per target model.
     * Structured single call first; per-model plain calls for anything that
     * comes back missing or unusable. Never throws for a bad rewrite — only
     * for transport / auth errors on the first call.
     * @returns {Promise<{prompts:Object<string,string>, cost:number|null,
     *   failed:string[], errors:Object<string,string>, mode:'generate'|'edit'}>}
     *   `failed` lists every target left without a prompt; `errors` maps only
     *   those whose fallback call threw to its message (`{}` when none did),
     *   so a rate limit or auth failure is not silently reported as a refusal.
     */
    async function enhancePrompt({ prompt, references, targetModels, rewriterModel, apiKey, temperature = 0.3, fetchImpl }) {
        const targets = (targetModels || []).filter(t => t && t.id);
        const mode = references && references.length ? 'edit' : 'generate';
        const model = rewriterModel || DEFAULT_REWRITER_MODEL;
        const result = { prompts: {}, cost: null, failed: [], errors: {}, mode };
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
                } else {
                    const message = o.reason?.message || String(o.reason);
                    result.errors[t.id] = message;
                    console.warn(`Enhancer fallback failed for ${t.id}: ${message}`);
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

    return {
        OPENROUTER_CHAT_URL,
        DEFAULT_REWRITER_MODEL,
        REWRITER_PRESETS,
        MODEL_PROFILES,
        getProfile,
        buildSystemPrompt,
        buildSchema,
        validateOutput,
        countWords,
        enhancePrompt,
        rerollPrompt
    };
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = ImagenEnhancer;
} else if (typeof window !== 'undefined') {
    window.ImagenEnhancer = ImagenEnhancer;
}
