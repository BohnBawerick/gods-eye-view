import { formatVesselLastSeen } from '../layers/vessels/recordPolicy.js';

/** Bind typed turns, whole-cache vessel search and persistent pins to the dock. */
export function bindTextCommands({ ui, session, runner, vessels }) {
  if (!ui.textForm) return () => {};
  let request = null;
  let pendingText = null;
  let watchRequest = null;
  let watchEntries = [];
  let resultEntries = [];
  let watchLoaded = false;
  let transcriptKey = null;
  let transcriptNode = null;
  let refreshTimer = null;

  function openPanel(open = true) {
    if (ui.agentPanel.hidden === !open) return;
    ui.agentPanel.hidden = !open;
    ui.agentToggle.setAttribute('aria-expanded', String(open));
    clearInterval(refreshTimer);
    refreshTimer = null;
    if (open) {
      void refreshWatchlist();
      refreshTimer = setInterval(() => void refreshWatchlist(), 60000);
    }
  }
  function say(role, text) {
    const line = document.createElement('p');
    const label = document.createElement('strong');
    label.textContent = `${role}: `;
    const content = document.createElement('span');
    content.textContent = text;
    line.append(label, content);
    ui.textLog.append(line);
    while (ui.textLog.childElementCount > 12)
      ui.textLog.firstElementChild.remove();
    return content;
  }
  function status(text) {
    ui.textStatus.textContent = text;
  }
  function beginRequest() {
    request?.abort();
    request = new AbortController();
    return request;
  }
  function owns(controller) {
    return (
      request === controller && !controller.signal.aborted && !session.disposed
    );
  }
  function button(text, action) {
    const element = document.createElement('button');
    element.type = 'button';
    element.textContent = text;
    element.addEventListener('click', action);
    return element;
  }
  function renderVessels(target, entries) {
    target.replaceChildren();
    for (const entry of entries) {
      const vessel = entry.vessel;
      const row = document.createElement('div');
      row.className = 'gev-vessel-result';
      row.dataset.stale = String(Boolean(vessel?.stale));
      const name = document.createElement('strong');
      name.textContent = vessel?.name || entry.name;
      const detail = document.createElement('p');
      detail.textContent = `MMSI ${entry.mmsi}${vessel?.imo && vessel.imo !== '0' ? ` / IMO ${vessel.imo}` : ''}`;
      const age = document.createElement('p');
      age.textContent = vessel
        ? `${formatVesselLastSeen(vessel.observedAtMs)}${vessel.stale ? ' / stale position' : ''}`
        : 'No retained position. Waiting for AIS reception.';
      if (Number.isFinite(vessel?.observedAtMs))
        age.title = new Date(vessel.observedAtMs).toISOString();
      const actions = document.createElement('div');
      const track = button(
        'Track this vessel',
        () => void trackVessel(entry.mmsi),
      );
      track.disabled = !vessel;
      const pinned = watchLoaded
        ? watchEntries.some((pin) => pin.mmsi === entry.mmsi)
        : vessel?.pinned === true;
      const pin = button(pinned ? 'Unpin' : 'Pin', async () => {
        pin.disabled = true;
        try {
          watchRequest?.abort();
          const result = await vessels.setVesselPinned(entry.mmsi, !pinned, {
            signal: session.signal,
          });
          if (session.disposed) return;
          watchEntries = result.entries;
          watchLoaded = true;
          renderVessels(ui.vesselWatchlist, watchEntries);
          renderVessels(ui.vesselResults, resultEntries);
          status(
            pinned
              ? 'Vessel removed from the shared watchlist.'
              : 'Vessel pinned. Its last known position will survive quiet periods and server restarts.',
          );
          void vessels.update?.();
        } catch (error) {
          if (!session.disposed) {
            status(error.message);
            pin.disabled = false;
          }
        }
      });
      actions.append(track, pin);
      row.append(name, detail, age, actions);
      target.append(row);
    }
  }
  function showCandidates(result) {
    const candidates = result.candidates || [];
    resultEntries = candidates.map((vessel) => ({
      mmsi: vessel.id,
      name: vessel.name,
      vessel,
    }));
    renderVessels(ui.vesselResults, resultEntries);
    if (result.total > 1)
      status(
        `${result.total} vessels match. Choose by MMSI.${result.total > candidates.length ? ' Showing the first 25; use a more specific name to narrow the list.' : ''}`,
      );
  }
  async function refreshWatchlist() {
    if (!vessels?.getWatchlist || watchRequest) return;
    watchRequest = new AbortController();
    const signal = AbortSignal.any([session.signal, watchRequest.signal]);
    try {
      const result = await vessels.getWatchlist({ signal });
      if (signal.aborted) return;
      watchEntries = result.entries;
      watchLoaded = true;
      renderVessels(ui.vesselWatchlist, watchEntries);
      renderVessels(ui.vesselResults, resultEntries);
      if (!watchEntries.length)
        ui.vesselWatchlist.textContent =
          'No pinned vessels. Search for a vessel, then choose Pin.';
      if (result.error) status(result.error);
    } catch (error) {
      if (!signal.aborted)
        ui.vesselWatchlist.textContent = `Watchlist unavailable: ${error.message}`;
    } finally {
      watchRequest = null;
    }
  }
  async function trackVessel(mmsi, controller = null) {
    if (!controller) {
      session.interrupt?.();
      controller = beginRequest();
    }
    status('Locating vessel…');
    try {
      const result = await runner(
        'track_entity',
        { query: mmsi, layerId: 'ais-live-vessels' },
        { signal: controller.signal, isCurrent: () => owns(controller) },
      );
      if (!owns(controller)) return;
      if (!result.ok) {
        status(result.error || 'Could not track this vessel.');
        return;
      }
      const age = Number.isFinite(result.observedAtMs)
        ? ` ${formatVesselLastSeen(result.observedAtMs)}.`
        : '';
      say(
        'Vessel',
        `Showing ${result.label}.${age}${result.stale ? ' This is a stale position, not a live fix.' : ''}`,
      );
      status(
        'Vessel layer on. Pin this vessel to keep its last known position.',
      );
    } catch (error) {
      if (owns(controller)) status(error.message);
    }
  }
  function flushText() {
    if (!pendingText || session.state !== 'listening') return;
    const text = pendingText;
    pendingText = null;
    try {
      session.sendText(text);
      status('Waiting for the agent…');
    } catch (error) {
      status(error.message);
    }
  }
  async function submit(event) {
    event.preventDefault();
    const text = ui.textInput.value.trim();
    if (!text) return;
    session.interrupt?.();
    pendingText = null;
    const controller = beginRequest();
    openPanel();
    say('You', text);
    ui.textInput.value = '';
    resultEntries = [];
    ui.vesselResults.replaceChildren();
    transcriptKey = null;
    status('Searching vessels…');
    const explicitVessel =
      ui.textMode.value === 'vessel' ||
      /^(?:MMSI\s*|IMO\s*)?\d{7,9}$/i.test(text) ||
      /^(?:track|find)\s+(?:vessel|ship)\s+/i.test(text);
    const query = text
      .replace(/^(?:track|find)\s+(?:vessel|ship)\s+/i, '')
      .trim();
    try {
      if (query.length <= 120 && vessels?.lookupVessels) {
        const result = await vessels.lookupVessels(query, {
          signal: controller.signal,
        });
        if (!owns(controller)) return;
        if (result?.total) {
          showCandidates(result);
          if (result.total === 1)
            await trackVessel(result.candidates[0].id, controller);
          return;
        }
      }
      if (explicitVessel) {
        status(
          'No retained AIS position matches. Check the name or number, or wait for reception. No AI session started.',
        );
        return;
      }
      if (!owns(controller)) return;
      pendingText = text;
      if (!session.isActive()) {
        status('Connecting to the agent without microphone access…');
        await session.start({ textOnly: true });
      }
      if (owns(controller)) flushText();
    } catch (error) {
      if (owns(controller)) status(error.message);
    }
  }
  const unsubscribe = session.subscribe((event) => {
    if (event.type === 'state') {
      if (event.state === 'listening') flushText();
      if (['idle', 'error'].includes(event.state)) {
        request?.abort();
        pendingText = null;
        if (event.state === 'error')
          status(
            event.detail ||
              'Agent connection failed. Retry or use vessel-only search.',
          );
      }
    }
    if (event.type === 'interruption') {
      request?.abort();
      pendingText = null;
    }
    if (event.type === 'action-result' && event.result?.candidates) {
      openPanel();
      showCandidates(event.result);
    }
    if (event.type === 'transcript' && event.text) {
      openPanel();
      const key = `${event.role}:${event.itemId || event.responseId || 'latest'}`;
      if (key !== transcriptKey) {
        transcriptKey = key;
        transcriptNode = say(event.role === 'user' ? 'You' : 'Agent', '');
      }
      transcriptNode.textContent = (
        event.final ? event.text : transcriptNode.textContent + event.text
      ).slice(0, 16000);
      if (event.final) status('');
    }
  });
  const toggle = () => openPanel(ui.agentPanel.hidden);
  const close = () => {
    openPanel(false);
    ui.agentToggle.focus();
  };
  const keydown = (event) => {
    if (event.key === 'Escape' && !ui.agentPanel.hidden) {
      event.stopPropagation();
      close();
    }
  };
  ui.textForm.addEventListener('submit', submit);
  ui.agentToggle.addEventListener('click', toggle);
  ui.agentClose.addEventListener('click', close);
  ui.root.addEventListener('keydown', keydown);
  return () => {
    request?.abort();
    watchRequest?.abort();
    clearInterval(refreshTimer);
    pendingText = null;
    unsubscribe();
    ui.textForm.removeEventListener('submit', submit);
    ui.agentToggle.removeEventListener('click', toggle);
    ui.agentClose.removeEventListener('click', close);
    ui.root.removeEventListener('keydown', keydown);
  };
}
