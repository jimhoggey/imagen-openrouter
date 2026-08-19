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

test('buildSystemPrompt (plain) asks for prose and never mentions the JSON object', () => {
    const sp = E.buildSystemPrompt([TARGETS[1]], 'generate', 'plain');
    assert.match(sp, /Return only the prompt text for this single target model\. No JSON, no quotes, no commentary\./);
    assert.doesNotMatch(sp, /JSON object/);
    assert.match(sp, /black-forest-labs\/flux\.2-pro \(FLUX\.2 Pro\)/);
    assert.match(sp, /Preserve intent exactly/);
});

test('buildSystemPrompt defaults to the JSON format', () => {
    assert.equal(E.buildSystemPrompt(TARGETS, 'generate'), E.buildSystemPrompt(TARGETS, 'generate', 'json'));
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

test('countWords counts whitespace-separated tokens', () => {
    assert.equal(E.countWords(''), 0);
    assert.equal(E.countWords('   '), 0);
    assert.equal(E.countWords(null), 0);
    assert.equal(E.countWords('a red cube'), 3);
    assert.equal(E.countWords('  one\ntwo   three \t four '), 4);
});

test('validateOutput allows a detailed prompt to be tightened', () => {
    const orig = 'A sprawling cyberpunk marketplace at night with dozens of neon signs in Japanese and '
        + 'Korean, steam rising from food stalls, crowds of shoppers in reflective raincoats, '
        + 'puddles mirroring the lights above';
    assert.ok(E.countWords(orig) >= 25);
    const terse = 'Neon-lit night market, steam, reflective raincoats, mirrored puddles, dense crowd, cinematic shot.';
    assert.equal(E.countWords(terse), 12);
    assert.equal(E.validateOutput(`  ${terse} `, orig), terse);
});

test('defaults', () => {
    assert.equal(E.DEFAULT_REWRITER_MODEL, 'google/gemini-2.5-flash');
    assert.ok(E.REWRITER_PRESETS.some(p => p.id === 'google/gemini-2.5-flash'));
});

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
    assert.deepEqual(r.errors, {});   // fulfilled-but-unusable is not a transport error
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

test('enhancePrompt: a JSON-wrapped plain fallback is unwrapped to prose', async () => {
    const fetchImpl = fakeFetch((body, n) => {
        if (n === 1) {
            return { choices: [{ message: { content: JSON.stringify({
                'google/gemini-3.1-flash-image': 'A glossy red cube rests on a walnut table, photorealistic.',
                'black-forest-labs/flux.2-pro': 'a red cube on a table'
            }) } }], usage: { cost: 0.0005 } };
        }
        // The rewriter ignores the plain instruction and answers with JSON anyway.
        assert.doesNotMatch(body.messages[0].content, /JSON object/);
        return { choices: [{ message: { content: JSON.stringify({
            'black-forest-labs/flux.2-pro': 'Red cube on walnut table, soft light, photoreal.'
        }) } }], usage: { cost: 0.0002 } };
    });
    const r = await E.enhancePrompt({ ...BASE, fetchImpl });
    assert.equal(fetchImpl.calls.length, 2);
    assert.equal(r.prompts['black-forest-labs/flux.2-pro'], 'Red cube on walnut table, soft light, photoreal.');
    assert.deepEqual(r.failed, []);
});

test('enhancePrompt: a throwing fallback is reported in failed and errors', async () => {
    const fetchImpl = fakeFetch((body, n) => {
        if (n === 1) {
            return { choices: [{ message: { content: JSON.stringify({
                'google/gemini-3.1-flash-image': 'a red cube on a table',
                'black-forest-labs/flux.2-pro': 'Red cube on a walnut table, soft daylight, photoreal render.'
            }) } }], usage: { cost: 0.0005 } };
        }
        return new Error('429 rate limited');
    });
    const warned = [];
    const realWarn = console.warn;
    console.warn = (...args) => warned.push(args.join(' '));
    let r;
    try {
        r = await E.enhancePrompt({ ...BASE, fetchImpl });
    } finally {
        console.warn = realWarn;
    }
    assert.equal(fetchImpl.calls.length, 2);
    assert.deepEqual(r.failed, ['google/gemini-3.1-flash-image']);
    assert.match(r.errors['google/gemini-3.1-flash-image'], /429/);
    assert.match(r.prompts['black-forest-labs/flux.2-pro'], /walnut/);
    assert.equal(warned.length, 1);
    assert.match(warned[0], /429/);
});
