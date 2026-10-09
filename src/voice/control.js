/** Build the voice control independently of its connection backend. */
export function createVoiceControl({ reset = false } = {}) {
  let root = document.getElementById('gev-voice-control');
  if (root && reset) {
    root.remove();
    root = null;
  }
  if (!root) {
    root = document.createElement('div');
    root.id = 'gev-voice-control';
    root.dataset.status = 'idle';
    root.dataset.speaker = 'idle';
    root.innerHTML = `
      <div class="gev-voice-heading">
        <div class="gev-voice-kicker">AI AGENT</div>
        <div id="gev-voice-status">OFF</div>
        <div class="gev-voice-cost">
          <button id="gev-voice-tier" class="gev-voice-tier-btn" type="button" aria-pressed="false" title="Voice model tier — applies next session">STD</button>
          <span id="gev-voice-cost-value" class="gev-voice-cost-value" data-level="ok" title="Estimated session cost">~$0.00</span>
        </div>
      </div>
      <button id="gev-voice-button" type="button" aria-label="Voice control — activate to toggle voice; hold Space to speak" aria-describedby="gev-voice-help">
        <span class="gev-mic-orbit"><img src="/mic.svg" alt="" /></span>
        <span class="gev-mic-label">ON/OFF</span>
      </button>
      <div class="gev-voice-visualizer" aria-hidden="true">
        ${Array.from({ length: 15 }, (_, index) => `<span style="--bar:${index}"></span>`).join('')}
      </div>
      <div class="gev-voice-readout">
        <div id="gev-voice-detail">VOICE STANDBY</div>
      </div>
      <form id="gev-text-form" class="gev-text-form">
        <label for="gev-text-input">Type to the agent or track a vessel</label>
        <div class="gev-text-entry">
          <input id="gev-text-input" name="command" type="text" maxlength="2000" autocomplete="off" placeholder="Ship name, MMSI, IMO or command" />
          <button type="submit">Send</button>
        </div>
        <div class="gev-text-options">
          <select id="gev-text-mode" aria-label="Command mode">
            <option value="auto">AI + vessel lookup</option>
            <option value="vessel">Track vessel only</option>
          </select>
          <button id="gev-agent-toggle" type="button" aria-expanded="false" aria-controls="gev-agent-panel">Replies / watchlist</button>
        </div>
      </form>
      <section id="gev-agent-panel" class="gev-agent-panel" aria-label="Agent replies and vessel watchlist" hidden>
        <div class="gev-agent-panel-heading"><strong>Agent / vessels</strong><button id="gev-agent-close" type="button" aria-label="Close replies and watchlist">Close</button></div>
        <p class="gev-agent-note">Vessel lookups are free. AI turns use the selected paid model. Typing never starts the microphone.</p>
        <div id="gev-text-log" role="log" aria-live="polite" aria-label="Conversation"></div>
        <p id="gev-text-status" role="status"></p>
        <div id="gev-vessel-results" aria-label="Vessel search results"></div>
        <h3>Watchlist</h3>
        <p class="gev-agent-note">Shared on this server. Last known positions kept for 7 days.</p>
        <div id="gev-vessel-watchlist"></div>
        <p class="gev-agent-note">Vessel positions: <a href="https://aisstream.io" target="_blank" rel="noopener noreferrer">AISStream.io</a>. Reception can be incomplete.</p>
      </section>
      <div id="gev-voice-help" class="gev-voice-help-tray" role="tooltip">
        <span class="gev-voice-help-kicker">VOICE CONTROL</span>
        <span class="gev-voice-help-detail">Hold Space to speak · tap Space to activate focused controls</span>
      </div>
      <div class="gev-voice-error-tray" role="alert" aria-live="assertive">
        <div class="gev-voice-error-header">
          <span>VOICE SYSTEM ERROR</span>
          <button class="gev-voice-error-dismiss" type="button">DISMISS</button>
        </div>
        <div id="gev-voice-error-detail"></div>
        <div class="gev-voice-error-hint">Check microphone permission and network access, then try again.</div>
      </div>
    `;
    const commandDock = document.getElementById('command-dock');
    if (commandDock) {
      const locationBar = document.getElementById('location-bar');
      const controlPanel = document.getElementById('control-panel');
      commandDock.appendChild(root);
      if (locationBar) commandDock.insertBefore(locationBar, root);
      if (controlPanel) commandDock.appendChild(controlPanel);
    } else {
      document.body.appendChild(root);
    }
    root
      .querySelector('.gev-voice-error-dismiss')
      ?.addEventListener('click', () => {
        root.classList.add('error-dismissed');
      });
  }
  return {
    root,
    button: root.querySelector('#gev-voice-button'),
    buttonLabel: root.querySelector('.gev-mic-label'),
    status: root.querySelector('#gev-voice-status'),
    detail: root.querySelector('#gev-voice-detail'),
    helpDetail: root.querySelector('.gev-voice-help-detail'),
    errorDetail: root.querySelector('#gev-voice-error-detail'),
    tierButton: root.querySelector('#gev-voice-tier'),
    costValue: root.querySelector('#gev-voice-cost-value'),
    textForm: root.querySelector('#gev-text-form'),
    textInput: root.querySelector('#gev-text-input'),
    textMode: root.querySelector('#gev-text-mode'),
    textLog: root.querySelector('#gev-text-log'),
    textStatus: root.querySelector('#gev-text-status'),
    agentPanel: root.querySelector('#gev-agent-panel'),
    agentToggle: root.querySelector('#gev-agent-toggle'),
    agentClose: root.querySelector('#gev-agent-close'),
    vesselResults: root.querySelector('#gev-vessel-results'),
    vesselWatchlist: root.querySelector('#gev-vessel-watchlist'),
  };
}
