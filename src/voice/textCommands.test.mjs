import test from 'node:test';
import assert from 'node:assert/strict';
import { bindTextCommands } from './textCommands.js';
import { createVoiceSession } from './session.js';

class Element extends EventTarget {
  children = [];
  dataset = {};
  textContent = '';
  value = '';
  hidden = false;
  append(...nodes) {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
  }
  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }
  remove() {
    this.parent.children = this.parent.children.filter((node) => node !== this);
  }
  get childElementCount() {
    return this.children.length;
  }
  get firstElementChild() {
    return this.children[0];
  }
  setAttribute(name, value) {
    this[name] = value;
  }
  focus() {}
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('typed dock routes ships without AI, queues only the latest no-mic turn and renders safe replies', async (t) => {
  const document = globalThis.document;
  globalThis.document = { createElement: () => new Element() };
  t.after(() => {
    globalThis.document = document;
  });
  const ui = Object.fromEntries(
    [
      'root',
      'textForm',
      'textInput',
      'textMode',
      'textLog',
      'textStatus',
      'agentPanel',
      'agentToggle',
      'agentClose',
      'vesselResults',
      'vesselWatchlist',
    ].map((key) => [key, new Element()]),
  );
  ui.agentPanel.hidden = true;
  ui.textMode.value = 'auto';
  const starts = [],
    sends = [],
    actions = [];
  let hooks;
  const session = createVoiceSession({
    runner: async () => ({}),
    createAdapter(options) {
      hooks = options;
      return {
        start(settings) {
          starts.push(settings);
        },
        stop() {},
        sendText(text) {
          sends.push(text);
        },
        sendMapEvent() {},
      };
    },
  });
  const vessel = {
    id: '259069000',
    name: 'SKANDI PEREGRINO',
    observedAtMs: Date.now() - 3600000,
    stale: true,
    imo: '9447627',
    pinned: true,
  };
  const vessels = {
    async getWatchlist() {
      return { entries: [{ mmsi: vessel.id, name: vessel.name, vessel }] };
    },
    async lookupVessels(query) {
      return {
        candidates: query === '9447627' ? [vessel] : [],
        total: query === '9447627' ? 1 : 0,
      };
    },
  };
  const cleanup = bindTextCommands({
    ui,
    session,
    vessels,
    runner: async (name, args) => {
      actions.push([name, args]);
      return {
        ok: true,
        label: vessel.name,
        observedAtMs: vessel.observedAtMs,
        stale: true,
      };
    },
  });
  t.after(() => {
    cleanup();
    session.destroy();
  });
  const submit = async (text) => {
    ui.textInput.value = text;
    ui.textForm.dispatchEvent(new Event('submit', { cancelable: true }));
    await tick();
  };
  await submit('9447627');
  assert.equal(starts.length, 0);
  assert.deepEqual(actions, [
    ['track_entity', { query: vessel.id, layerId: 'ais-live-vessels' }],
  ]);
  assert.equal(ui.vesselResults.children.length, 1);
  assert.match(
    ui.textLog.children[1].children[1].textContent,
    /stale position/,
  );
  await submit('999999999');
  assert.equal(starts.length, 0);
  assert.match(ui.textStatus.textContent, /No retained AIS/);
  await submit('Turn on HUD');
  await submit('Zoom out');
  assert.deepEqual(starts, [{ textOnly: true }]);
  assert.deepEqual(sends, []);
  hooks.emit({ type: 'state', state: 'listening' });
  assert.deepEqual(sends, ['Zoom out']);
  hooks.emit({
    type: 'transcript',
    role: 'assistant',
    itemId: 'one',
    text: '<b>Zoomed',
    final: false,
  });
  hooks.emit({
    type: 'transcript',
    role: 'assistant',
    itemId: 'one',
    text: '<b>Zoomed out.</b>',
    final: true,
  });
  assert.equal(
    ui.textLog.children.at(-1).children[1].textContent,
    '<b>Zoomed out.</b>',
  );
  assert.equal(ui.textLog.children.at(-1).children[1].children.length, 0);
  session.stop();
  await submit('Turn off HUD');
  session.stop();
  hooks.emit({ type: 'state', state: 'listening' });
  assert.deepEqual(sends, ['Zoom out'], 'stopping clears the queued command');
  let finish;
  vessels.lookupVessels = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  await submit('PEREGRINO');
  hooks.emit({ type: 'interruption', reason: 'user-speech' });
  finish({ candidates: [vessel], total: 1 });
  await tick();
  assert.equal(
    actions.length,
    1,
    'a spoken interruption cancels the pending typed lookup',
  );
});
