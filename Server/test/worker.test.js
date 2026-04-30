'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const WORKER_PATH = path.resolve(__dirname, '../src/worker.js');
const ENV_KEYS = ['OPENAI_KEY', 'HMAC_KEY', 'AI_MODEL', 'DISCORD_WEBHOOK_URL'];

function loadWorker(env) {
    delete require.cache[WORKER_PATH];

    for (const k of ENV_KEYS) {
        if (k in env) globalThis[k] = env[k];
        else delete globalThis[k];
    }

    let fetchListener = null;
    globalThis.addEventListener = (name, fn) => {
        if (name === 'fetch') fetchListener = fn;
    };

    require(WORKER_PATH);
    if (!fetchListener) throw new Error('worker did not register fetch listener');
    return fetchListener;
}

function fakeWhisperRequest(body = 'fake-audio') {
    return new Request('https://worker.example/v1/audio/transcriptions', {
        method: 'POST',
        headers: { 'Content-Type': 'multipart/form-data' },
        body,
    });
}

function runListener(listener, request) {
    const waitUntilPromises = [];
    let respondPromise;
    const event = {
        request,
        respondWith(p) { respondPromise = p; },
        waitUntil(p) { waitUntilPromises.push(Promise.resolve(p)); },
    };
    listener(event);
    return { respondPromise, waitUntilPromises };
}

// --- Tests ---

test('DISCORD_WEBHOOK_URL unset → only OpenAI is called', async () => {
    const calls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input.url;
        calls.push({ url, init });
        return new Response(JSON.stringify({ text: 'hello' }), {
            status: 200, headers: { 'Content-Type': 'application/json' },
        });
    };

    try {
        const listener = loadWorker({ OPENAI_KEY: 'sk-test' });
        const { respondPromise, waitUntilPromises } = runListener(listener, fakeWhisperRequest());

        const res = await respondPromise;
        await Promise.all(waitUntilPromises);

        assert.equal(res.status, 200);
        assert.equal(calls.length, 1, 'only OpenAI should be called');
        assert.match(calls[0].url, /api\.openai\.com/);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('DISCORD_WEBHOOK_URL set + Whisper 200 → Discord receives transcribed text', async () => {
    const calls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input.url;
        calls.push({ url, init });
        if (url.includes('api.openai.com')) {
            return new Response(JSON.stringify({ text: 'hello world' }), {
                status: 200, headers: { 'Content-Type': 'application/json' },
            });
        }
        if (url.includes('discord.example')) {
            return new Response(null, { status: 204 });
        }
        throw new Error('unexpected fetch: ' + url);
    };

    try {
        const listener = loadWorker({
            OPENAI_KEY: 'sk-test',
            DISCORD_WEBHOOK_URL: 'https://discord.example/webhook/abc',
        });
        const { respondPromise, waitUntilPromises } = runListener(listener, fakeWhisperRequest());

        const res = await respondPromise;
        await Promise.all(waitUntilPromises);

        assert.equal(res.status, 200);
        const discordCalls = calls.filter(c => c.url.includes('discord.example'));
        assert.equal(discordCalls.length, 1, 'Discord webhook should be hit exactly once');

        const body = JSON.parse(discordCalls[0].init.body);
        assert.equal(body.content, 'hello world');
        assert.equal(discordCalls[0].init.method, 'POST');
        assert.equal(discordCalls[0].init.headers['Content-Type'], 'application/json');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('Long transcription text > 2000 chars is split across multiple Discord posts', async () => {
    const longText = 'a'.repeat(4500); // 2000 + 2000 + 500
    const calls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input.url;
        calls.push({ url, init });
        if (url.includes('api.openai.com')) {
            return new Response(JSON.stringify({ text: longText }), {
                status: 200, headers: { 'Content-Type': 'application/json' },
            });
        }
        return new Response(null, { status: 204 });
    };

    try {
        const listener = loadWorker({
            OPENAI_KEY: 'sk-test',
            DISCORD_WEBHOOK_URL: 'https://discord.example/webhook/abc',
        });
        const { respondPromise, waitUntilPromises } = runListener(listener, fakeWhisperRequest());

        await respondPromise;
        await Promise.all(waitUntilPromises);

        const discordCalls = calls.filter(c => c.url.includes('discord.example'));
        assert.equal(discordCalls.length, 3, '4500 chars should split into 3 chunks (2000+2000+500)');

        const sizes = discordCalls.map(c => JSON.parse(c.init.body).content.length);
        assert.deepEqual(sizes, [2000, 2000, 500]);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('Whisper non-OK response → Discord is NOT called', async () => {
    const calls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input.url;
        calls.push({ url, init });
        if (url.includes('api.openai.com')) {
            return new Response('{"error":"x"}', {
                status: 500, headers: { 'Content-Type': 'application/json' },
            });
        }
        return new Response(null, { status: 204 });
    };

    try {
        const listener = loadWorker({
            OPENAI_KEY: 'sk-test',
            DISCORD_WEBHOOK_URL: 'https://discord.example/webhook/abc',
        });
        const { respondPromise, waitUntilPromises } = runListener(listener, fakeWhisperRequest());

        await respondPromise;
        await Promise.all(waitUntilPromises);

        const discordCalls = calls.filter(c => c.url.includes('discord.example'));
        assert.equal(discordCalls.length, 0, 'Discord should NOT be called when Whisper fails');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('Empty transcribed text → no Discord post', async () => {
    const calls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input.url;
        calls.push({ url, init });
        if (url.includes('api.openai.com')) {
            return new Response(JSON.stringify({ text: '   ' }), {
                status: 200, headers: { 'Content-Type': 'application/json' },
            });
        }
        return new Response(null, { status: 204 });
    };

    try {
        const listener = loadWorker({
            OPENAI_KEY: 'sk-test',
            DISCORD_WEBHOOK_URL: 'https://discord.example/webhook/abc',
        });
        const { respondPromise, waitUntilPromises } = runListener(listener, fakeWhisperRequest());

        await respondPromise;
        await Promise.all(waitUntilPromises);

        const discordCalls = calls.filter(c => c.url.includes('discord.example'));
        assert.equal(discordCalls.length, 0, 'whitespace-only text should be skipped');
    } finally {
        globalThis.fetch = originalFetch;
    }
});
