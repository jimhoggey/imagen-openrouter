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
