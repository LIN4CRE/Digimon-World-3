/**
 * PSXpress shell.
 *
 * Boot order matters and is visible to the player:
 *   1. this file paints the frame the server sent (no framework, no bundle),
 *   2. the manifest arrives and the stage list is drawn,
 *   3. the disc hydrates, stage by stage, from the local server into IndexedDB,
 *   4. the emulator core is fetched and compiled while the image is assembled,
 *   5. the machine boots at the title screen.
 *
 * A launch where every chunk is already cached skips step 3 entirely and goes
 * straight to assembling the image from IndexedDB — no network at all.
 */
import { Hydration } from './loader.js';
import { Saves, download } from './saves.js';
import { requestPersistence, storageEstimate, store, sha256 } from './cache.js';
import { Ps1Runtime } from './runtime.js';
import { BIOS_BYTES } from './core-constants.js';

const $ = (id) => document.getElementById(id);
const elements = {
  title: $('game-title'),
  sub: $('game-sub'),
  bar: $('bar-fill'),
  progressText: $('progress-text'),
  progressRate: $('progress-rate'),
  stages: $('stages'),
  play: $('play'),
  messages: $('messages'),
  stageScreen: $('stage-screen'),
  player: $('player'),
  screen: $('screen'),
  meta: $('disc-meta'),
  hudFps: $('hud-fps'),
  hudAudio: $('hud-audio'),
  hudMode: $('hud-mode'),
  footCache: $('foot-cache'),
  footStorage: $('foot-storage'),
  footDisc: $('foot-disc'),
  footSw: $('foot-sw'),
  biosDialog: $('bios-dialog'),
  biosFile: $('bios-file'),
  biosStatus: $('bios-status'),
  biosCancel: $('bios-cancel'),
  settingsDialog: $('settings-dialog'),
  settingsStorage: $('settings-storage'),
  settingScale: $('setting-scale'),
  settingVolume: $('setting-volume'),
};

const state = {
  manifest: null,
  hydration: null,
  saves: null,
  runtime: null,
  bios: null,
  phase: 'boot',
  autosaveTimer: null,
  lastHudAt: 0,
};

const formatBytes = (bytes) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** exponent).toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
};
const formatRate = (bytesPerSecond) => (bytesPerSecond > 0 ? `${formatBytes(bytesPerSecond)}/s` : '');
const formatDuration = (seconds) => {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  return `${Math.floor(seconds / 60)}m ${String(Math.ceil(seconds % 60)).padStart(2, '0')}s`;
};

function message(text, kind = 'info', { sticky = false } = {}) {
  const node = document.createElement('div');
  node.className = `message ${kind}`;
  node.innerHTML = text;
  if (kind === 'error') {
    const retry = document.createElement('button');
    retry.textContent = 'Retry';
    retry.style.marginLeft = '10px';
    retry.addEventListener('click', () => location.reload());
    node.append(retry);
  }
  if (!sticky) {
    setTimeout(() => node.remove(), 12_000);
  }
  elements.messages.append(node);
  return node;
}

function setProgress(fraction, text, rate = '') {
  const percent = Math.max(0, Math.min(1, fraction ?? 0)) * 100;
  elements.bar.style.width = `${percent.toFixed(1)}%`;
  elements.bar.parentElement.setAttribute('aria-valuenow', String(Math.round(percent)));
  if (text) elements.progressText.textContent = text;
  elements.progressRate.textContent = rate;
}

function renderStages(stageState) {
  if (!stageState) return;
  if (!elements.stages.dataset.rendered) {
    elements.stages.innerHTML = stageState
      .map(
        (stage) => `
        <li class="stage" data-index="${stage.index}" data-state="pending">
          <span class="dot"></span>
          <span class="label">${stage.label}<small>${stage.id}</small></span>
          <span class="size" data-size></span>
          <div class="fill"><i></i></div>
        </li>`,
      )
      .join('');
    elements.stages.dataset.rendered = '1';
  }
  for (const stage of stageState) {
    const node = elements.stages.querySelector(`[data-index="${stage.index}"]`);
    if (!node) continue;
    const bytes = state.manifest?.stages.find((s) => s.index === stage.index)?.bytes ?? 0;
    node.querySelector('[data-size]').textContent = formatBytes(bytes);
    node.dataset.state = stage.fraction >= 1 ? 'done' : stage.fraction > 0 ? 'active' : 'pending';
    node.querySelector('.fill > i').style.width = `${(stage.fraction * 100).toFixed(1)}%`;
  }
}

function describeManifest(manifest) {
  const { game, disc, summary } = manifest;
  elements.title.textContent = game.title ?? 'Unknown disc';
  const parts = [
    game.serial ? `<code>${game.serial}</code>` : 'no serial in SYSTEM.CNF',
    game.region ?? '?',
    `${summary.fileCount} files`,
    `${formatBytes(summary.payloadBytes)} payload`,
    `${disc.sectorCount} sectors @ ${disc.sectorSize} B (${disc.mode})`,
  ];
  elements.sub.innerHTML = parts.join(' · ');
  elements.meta.innerHTML = `${game.title ?? 'disc'}<br />${game.serial ?? ''} ${game.region ? `· ${game.region}` : ''}`;
  elements.footDisc.textContent = `disc: ${manifest.discId.slice(0, 10)}… ${formatBytes(manifest.imageBytes)}`;
  if (manifest.runtime?.core?.streaming === false) {
    const note = document.createElement('div');
    note.className = 'message';
    note.innerHTML = `<strong>How this launch works:</strong> ${manifest.runtime.core.streamingNote ??
      'the emulator core needs the whole disc image before it boots.'} Progress below is real disk progress, not a spinner.`;
    elements.messages.append(note);
  }
  if (manifest.warnings?.length) {
    for (const warning of manifest.warnings.slice(0, 4)) message(`Manifest warning: ${warning}`, 'error', { sticky: true });
  }
}

async function getJson(url) {
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.json();
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    elements.footSw.textContent = 'service worker: unsupported';
    return null;
  }
  if (location.hostname === 'localhost' && new URLSearchParams(location.search).has('nosw')) {
    elements.footSw.textContent = 'service worker: disabled by ?nosw';
    return null;
  }
  try {
    const registration = await navigator.serviceWorker.register('/sw.js');
    elements.footSw.textContent = `service worker: ${registration.active ? 'active' : 'installing'}`;
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data?.type === 'version') elements.footSw.textContent = `service worker: v${event.data.version}`;
    });
    return registration;
  } catch (error) {
    elements.footSw.textContent = 'service worker: failed';
    message(`The offline cache could not start: ${error.message}`, 'error');
    return null;
  }
}

async function updateStorageFootnote() {
  const estimate = await storageEstimate();
  if (!estimate) {
    elements.footStorage.textContent = 'storage: unknown';
    return;
  }
  const persisted = (await navigator.storage?.persisted?.()) ? 'persistent' : 'best effort';
  elements.footStorage.textContent = `storage: ${formatBytes(estimate.usage)} of ${formatBytes(estimate.quota)} (${persisted})`;
  elements.settingsStorage.textContent = `${formatBytes(estimate.usage)} used of ${formatBytes(estimate.quota)} available. Cached disc chunks are kept until you clear them; clearing frees the space but the next launch downloads again.`;
}

async function loadBiosFromStore() {
  const record = await store.get('meta', 'bios');
  if (record?.bytes) {
    state.bios = { bytes: new Uint8Array(record.bytes), hash: record.hash, source: record.source ?? 'stored' };
    return state.bios;
  }
  // A BIOS placed in web/cores/bios.bin by whoever runs the server is used as
  // a convenience; otherwise the player supplies one.
  try {
    const head = await fetch('/cores/bios.bin', { method: 'HEAD', cache: 'no-store' });
    if (head.ok) {
      const bytes = new Uint8Array(await (await fetch('/cores/bios.bin', { cache: 'no-store' })).arrayBuffer());
      if (bytes.byteLength === BIOS_BYTES) {
        const hash = await sha256(bytes);
        await store.put('meta', 'bios', { bytes, hash, source: '/cores/bios.bin', storedAt: Date.now() });
        state.bios = { bytes, hash, source: '/cores/bios.bin' };
        message('Using the BIOS image installed beside the server.', 'good');
        return state.bios;
      }
    }
  } catch {
    /* no bundled BIOS: that is the normal case */
  }
  return null;
}

function promptForBios() {
  return new Promise((resolve) => {
    elements.biosDialog.showModal();
    elements.biosStatus.hidden = true;
    const done = (value) => {
      elements.biosFile.value = '';
      elements.biosDialog.close();
      resolve(value);
    };
    elements.biosCancel.onclick = () => done(null);
    elements.biosFile.onchange = async () => {
      const file = elements.biosFile.files?.[0];
      if (!file) return;
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (bytes.byteLength !== BIOS_BYTES) {
        elements.biosStatus.hidden = false;
        elements.biosStatus.className = 'message error';
        elements.biosStatus.textContent = `That file is ${bytes.byteLength} bytes. A PlayStation BIOS image is exactly 524288 bytes (512 KiB).`;
        return;
      }
      const hash = await sha256(bytes);
      await store.put('meta', 'bios', { bytes, hash, source: file.name, storedAt: Date.now() });
      state.bios = { bytes, hash, source: file.name };
      message(`BIOS stored locally (${file.name}, ${hash.slice(0, 12)}…).`, 'good');
      done(state.bios);
    };
  });
}

async function hydrate() {
  const { manifest } = state;
  setProgress(0, 'Scanning the browser cache…');
  state.hydration = new Hydration({
    manifest,
    onProgress: (event) => {
      if (event.stages) renderStages(event.stages);
      if (event.phase === 'cached') {
        setProgress(1, 'Already cached (no download needed)');
        return;
      }
      if (event.phase === 'hydrating' || event.phase === 'ready') {
        const eta = formatDuration(event.etaSeconds);
        setProgress(
          event.fraction,
          `${formatBytes(event.bytesDone)} of ${formatBytes(event.bytesTotal)} · ${event.chunksDone}/${event.chunksTotal} chunks`,
          [`${formatRate(event.rate)}`, eta ? `ETA ${eta}` : ''].filter(Boolean).join(' · '),
        );
      }
      if (event.phase === 'error') message(event.error, 'error');
    },
  });
  await state.hydration.init();
  if (state.hydration.complete) {
    setProgress(1, 'Every sector is cached on this device');
    elements.footCache.textContent = 'cache: warm';
    return;
  }
  const started = performance.now();
  await state.hydration.hydrateAll();
  const seconds = (performance.now() - started) / 1000;
  elements.footCache.textContent = `cache: ${formatBytes(manifest.imageBytes)} stored in ${seconds.toFixed(1)}s`;
  message(`Disc cached locally in ${seconds.toFixed(1)}s. The next launch needs no download.`, 'good');
}

function readyToPlay(reason) {
  state.phase = 'ready';
  elements.play.disabled = false;
  elements.play.textContent = state.bios ? 'Play' : 'Play (BIOS needed)';
  setProgress(1, reason ?? 'Ready');
}

async function play() {
  if (state.phase === 'playing' || state.phase === 'starting') return;
  if (!state.bios) {
    const bios = await promptForBios();
    if (!bios) return;
    elements.play.textContent = 'Play';
  }
  state.phase = 'starting';
  elements.play.disabled = true;
  const startedAt = performance.now();
  const original = elements.play.textContent;
  elements.play.innerHTML = '<span class="spinner"></span> Starting…';
  try {
    let image = await state.hydration.assemble((fraction) =>
      setProgress(fraction, `Assembling the disc image (${formatBytes(state.manifest.imageBytes)})`),
    );
    const { runtime } = state.manifest;
    const rt = new Ps1Runtime({ canvas: elements.screen, onState: updateHud });
    await rt.loadCore({
      wasmUrl: runtime.core.wasm,
      onProgress: (p) => setProgress(p.fraction, `Loading the emulator core (${formatBytes(p.total)})`, formatBytes(p.received)),
    });
    setProgress(1, 'Installing the BIOS and inserting the disc…');
    rt.loadBios(state.bios.bytes);
    const cue = state.manifest.disc.cueText ?? buildCue(state.manifest);
    rt.loadDisc({ image, cue });
    image = null; // the core owns a copy; let the JS one go
    await rt.startAudio();
    rt.setVolume(Number(elements.settingVolume.value) / 100);
    rt.presenter.scaleMode = elements.settingScale.value;
    rt.start();
    state.runtime = rt;
    state.phase = 'playing';
    const bootSeconds = (performance.now() - startedAt) / 1000;
    elements.stageScreen.hidden = true;
    elements.player.hidden = false;
    elements.player.focus?.();
    message(`Running. Cold start to first frame: ${bootSeconds.toFixed(2)}s.`, 'good');
    state.autosaveTimer = setInterval(autosave, 20_000);
    window.addEventListener('pagehide', autosave);
    elements.meta.innerHTML = `${state.manifest.game.title ?? 'disc'}<br />Esc pause · Tab speed`;
  } catch (error) {
    console.error(error);
    state.phase = 'ready';
    elements.play.disabled = false;
    elements.play.textContent = original;
    message(`The machine did not start: ${error.message}`, 'error', { sticky: true });
    if (error.code === 'BAD_BIOS_SIZE') promptForBios();
  }
}

function buildCue(manifest) {
  return `FILE "disc.bin" BINARY\n  TRACK 01 ${manifest.disc.mode}\n    INDEX 01 00:00:00\n`;
}

function updateHud(info) {
  const now = performance.now();
  if (now - state.lastHudAt < 400) return;
  state.lastHudAt = now;
  elements.hudFps.textContent = `${info.fps} fps`;
  elements.hudAudio.textContent = `audio ${formatBytes(info.audioPushed ?? 0)}`;
  elements.hudMode.textContent = info.paused ? 'paused' : info.fastForward ? 'fast-forward' : 'running';
}

async function autosave() {
  const rt = state.runtime;
  if (!rt || !state.saves) return;
  try {
    const card = rt.takeMemcard();
    if (card) {
      const result = await state.saves.writeCard(0, card);
      if (result.written) message('Memory card saved.', 'good');
    }
  } catch (error) {
    message(`The memory card could not be written: ${error.message}`, 'error');
  }
}

function wireSettings() {
  $('btn-settings').addEventListener('click', async () => {
    await updateStorageFootnote();
    elements.settingsDialog.showModal();
  });
  $('settings-close').addEventListener('click', () => elements.settingsDialog.close());
  elements.settingScale.addEventListener('change', () => {
    if (state.runtime) state.runtime.presenter.scaleMode = elements.settingScale.value;
    store.put('meta', 'scale', elements.settingScale.value);
  });
  elements.settingVolume.addEventListener('input', () => {
    state.runtime?.setVolume(Number(elements.settingVolume.value) / 100);
    store.put('meta', 'volume', Number(elements.settingVolume.value));
  });
  $('btn-export-card').addEventListener('click', async () => {
    try {
      const blob = await state.saves.exportCard(0);
      download(blob, `${state.manifest.discId}-slot0.mcr`);
    } catch (error) {
      message(error.message, 'error');
    }
  });
  $('btn-import-card').addEventListener('click', () => $('import-card-file').click());
  $('import-card-file').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      await state.saves.importCard(0, file);
      if (state.runtime) state.runtime.installMemcard(await state.saves.readCard(0));
      message(`Imported ${file.name}.`, 'good');
    } catch (error) {
      message(error.message, 'error');
    }
  });
  $('btn-clear').addEventListener('click', async () => {
    if (!confirm('Delete the cached disc chunks? The next launch will download them again.')) return;
    await state.hydration.cache.clear();
    message('Cached chunks cleared.', 'good');
    location.reload();
  });
}

function wireShortcuts() {
  window.addEventListener('keydown', (event) => {
    const rt = state.runtime;
    if (!rt) return;
    if (event.code === 'Escape') {
      rt.pause(!rt.paused);
      message(rt.paused ? 'Paused.' : 'Resumed.', 'info');
    } else if (event.code === 'Tab') {
      event.preventDefault();
      rt.fastForward = true;
    } else if (event.code === 'F2') {
      event.preventDefault();
      state.saves.writeState(0, rt.saveState()).then(() => message('Save state written.', 'good'));
    } else if (event.code === 'F3') {
      event.preventDefault();
      state.saves.readState(0).then((bytes) => {
        if (!bytes) return message('No save state yet. Press F2 first.', 'error');
        rt.loadState(bytes);
        message('Save state loaded.', 'good');
      });
    } else if (event.code === 'F11') {
      event.preventDefault();
      if (document.fullscreenElement) document.exitFullscreen();
      else elements.player.requestFullscreen?.();
    }
  });
  window.addEventListener('keyup', (event) => {
    if (event.code === 'Tab' && state.runtime) state.runtime.fastForward = false;
  });
}

async function boot() {
  const started = performance.now();
  await registerServiceWorker();
  const manifest = await getJson('/api/manifest');
  state.manifest = manifest;
  state.saves = new Saves(manifest.discId);
  describeManifest(manifest);
  renderStages(manifest.stages.map((stage) => ({ ...stage, fraction: 0, totalChunks: 0, doneChunks: 0 })));
  setProgress(0, 'Checking what is already cached…');

  const persistence = await requestPersistence();
  if (!persistence.persisted && persistence.reason === 'denied') {
    message(
      'The browser would not grant persistent storage, so the disc cache may be evicted when space runs low. Export your memory card to keep progress safe.',
      'error',
    );
  }
  await updateStorageFootnote();

  state.bios = await loadBiosFromStore();
  if (!state.bios) message('A BIOS image is needed before the machine can boot. Press Play to choose one.', 'info');

  const settingsScale = await store.get('meta', 'scale');
  if (settingsScale) elements.settingScale.value = settingsScale;
  const settingsVolume = await store.get('meta', 'volume');
  if (typeof settingsVolume === 'number') elements.settingVolume.value = String(settingsVolume);

  elements.play.addEventListener('click', play);
  wireSettings();
  wireShortcuts();

  try {
    await hydrate();
  } catch (error) {
    state.phase = 'error';
    message(`Downloading the disc failed: ${error.message}`, 'error', { sticky: true });
    setProgress(0, 'Stopped');
    return;
  }

  const seconds = (performance.now() - started) / 1000;
  readyToPlay(`Ready in ${seconds.toFixed(1)}s`);
}

boot().catch((error) => {
  console.error(error);
  elements.title.textContent = 'PSXpress could not start';
  elements.sub.textContent = error.message;
  setProgress(0, 'Stopped');
  message(
    `The shell could not reach its server (${error.message}). Start it with <code>npx psxpress serve &lt;disc&gt;</code> and reload.`,
    'error',
    { sticky: true },
  );
});
