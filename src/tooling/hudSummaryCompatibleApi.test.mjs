import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { handleHudSummary } from '../../server/providers/openai/hud-summary.js';

async function callHudSummary(context) {
  const req = Readable.from([Buffer.from(JSON.stringify(context))]);
  req.method = 'POST';
  req.headers = {};
  req.socket = { remoteAddress: '127.0.0.1' };
  const res = { statusCode: 200, headers: {}, body: '' };
  res.setHeader = (name, value) => {
    res.headers[name.toLowerCase()] = value;
  };
  await new Promise((resolve) => {
    res.end = (body = '') => {
      res.body = body;
      resolve();
    };
    handleHudSummary(req, res);
  });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

test('HUD summary uses an OpenAI-compatible chat API when GEV_HUD_LLM_BASE_URL is set', async (t) => {
  const saved = { ...process.env };
  t.after(() => {
    for (const name of [
      'GEV_HUD_LLM_BASE_URL',
      'GEV_HUD_LLM_API_KEY',
      'OPENAI_API_KEY',
      'OPENAI_HUD_SUMMARY_MODEL',
    ]) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });
  process.env.GEV_HUD_LLM_BASE_URL = 'https://llm.example/v1/';
  process.env.GEV_HUD_LLM_API_KEY = 'fixture-compatible-key';
  process.env.OPENAI_API_KEY = 'fixture-openai-key';
  process.env.OPENAI_HUD_SUMMARY_MODEL = 'fixture-model';

  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return Response.json({
      choices: [
        { message: { content: 'Perth: live flights, over the river!' } },
      ],
    });
  });

  const response = await callHudSummary({
    place: 'Perth',
    layers: ['Flights'],
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.summary, 'Perth live flights over the');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://llm.example/v1/chat/completions');
  assert.equal(
    calls[0].options.headers.Authorization,
    'Bearer fixture-compatible-key',
  );
  assert.equal(calls[0].body.model, 'fixture-model');
  assert.equal(calls[0].body.messages[0].role, 'system');
  assert.deepEqual(JSON.parse(calls[0].body.messages[1].content), {
    place: 'Perth',
    layers: ['Flights'],
  });
});

test('HUD summary without GEV_HUD_LLM_BASE_URL still calls the OpenAI Responses API', async (t) => {
  const saved = { ...process.env };
  t.after(() => {
    for (const name of ['GEV_HUD_LLM_BASE_URL', 'OPENAI_API_KEY']) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });
  delete process.env.GEV_HUD_LLM_BASE_URL;
  process.env.OPENAI_API_KEY = 'fixture-openai-key';

  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    return Response.json({ output_text: 'Perth live flights above city' });
  });

  const response = await callHudSummary({ place: 'Perth' });

  assert.equal(response.status, 200);
  assert.equal(response.body.summary, 'Perth live flights above city');
  assert.equal(calls[0].url, 'https://api.openai.com/v1/responses');
  assert.equal(
    calls[0].options.headers.Authorization,
    'Bearer fixture-openai-key',
  );
});
