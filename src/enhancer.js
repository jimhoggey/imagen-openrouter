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
