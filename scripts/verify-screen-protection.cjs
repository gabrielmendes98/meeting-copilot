// Run with Electron, passing a compiled native/screen-protection-check helper.
// Creates temporary test windows and reports only color ratios.
const { app, BrowserWindow, screen } = require('electron');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { createInterface } = require('node:readline');
const execute = promisify(execFile);
const helper = process.argv[2];
let background, marker, watcher;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const mostlyGray = (data) => data.grayRatio > 0.9 && data.redRatio < 0.05;
const mostlyRed = (data) => data.redRatio > 0.9;

function displayResult(api, samples) {
  const { baseline, unprotected, protectedCapture, hidden } = samples;
  const controlsPassed = mostlyGray(baseline) && mostlyRed(unprotected) && mostlyGray(hidden);
  const result = !controlsPassed ? 'inconclusive'
    : mostlyGray(protectedCapture) ? 'excluded-in-this-test'
    : protectedCapture.redRatio >= 0.05 ? 'protected-overlay-visible' : 'inconclusive';
  return { api, ...samples, result };
}

function markerPage(color) {
  // A small heartbeat forces new frames even if protection does not change the
  // composite. It occupies less than 2% of the sampled area.
  return 'data:text/html,' + encodeURIComponent(
    `<style>body{margin:0;background:${color}}i{position:absolute;left:120px;top:70px;width:12px;height:12px;
    background:#0080ff;animation:heartbeat .4s steps(1) infinite}
    @keyframes heartbeat{50%{background:#00ffaa}}</style><body><i></i></body>`,
  );
}

app.setName('Meeting Copilot Capture Check');
console.error('Starting the screen-share protection diagnostic…');
const startupTimeout = setTimeout(() => {
  console.error('Timed out waiting for Electron to initialize the test windows.');
  app.exit(1);
}, 15_000);
app.whenReady().then(async () => {
  const results = [];
  try {
    if (process.platform !== 'darwin' || !helper) throw new Error('Pass the compiled macOS capture-check helper.');
    app.setActivationPolicy('accessory');
    app.dock?.hide();
    const display = screen.getPrimaryDisplay();
    const x = display.workArea.x + 24;
    const y = display.workArea.y + 24;
    const title = `Meeting Copilot Capture Target ${process.pid}`;
    const region = [x + 100 - display.bounds.x, y + 50 - display.bounds.y, 100, 80].map(String);
    const options = {
      x, y, width: 320, height: 180, frame: false, show: false, focusable: false,
      skipTaskbar: true, alwaysOnTop: true, hasShadow: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    };
    background = new BrowserWindow({ ...options, title, backgroundColor: '#202020' });
    marker = new BrowserWindow({ ...options, transparent: true, backgroundColor: '#00000000' });
    for (const window of [background, marker]) {
      window.setAlwaysOnTop(true, 'screen-saver');
      window.setIgnoreMouseEvents(true);
      window.setHiddenInMissionControl(true);
    }
    await background.loadURL(markerPage('#202020'));
    await marker.loadURL(markerPage('#ff0000'));
    background.setTitle(title);
    clearTimeout(startupTimeout);

    console.error('Checking macOS screen recording permission…');
    try {
      await execute(helper, ['--request-access'], { timeout: 60_000, killSignal: 'SIGKILL' });
    } catch (error) {
      if (error.killed) throw new Error('Timed out waiting for macOS screen recording approval.');
      throw new Error(error.stderr?.trim() || error.message);
    }
    background.showInactive();

    async function sample(args) {
      await delay(500);
      try {
        const { stdout } = await execute(helper, args, { timeout: 20_000, killSignal: 'SIGKILL' });
        return JSON.parse(stdout);
      } catch (error) {
        if (error.killed) throw new Error('Timed out waiting for the macOS capture helper after 20 seconds.');
        throw new Error(error.stderr?.trim() || error.message);
      }
    }

    async function measureDisplay(api, nextSample) {
      console.error(`Testing ${api}…`);
      marker.hide();
      marker.setContentProtection(false);
      const baseline = await nextSample();
      marker.showInactive();
      const unprotected = await nextSample();
      marker.setContentProtection(true);
      const protectedCapture = await nextSample();
      marker.hide();
      const hidden = await nextSample();
      return displayResult(api, { baseline, unprotected, protectedCapture, hidden });
    }

    results.push(await measureDisplay('SCScreenshotManager/display', () => sample(region)));
    results.push(await measureDisplay('SCStream/new-display', () => sample([...region, '--stream'])));

    watcher = spawn(helper, [...region, '--watch'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const lines = createInterface({ input: watcher.stdout });
    let latest, frame = 0, captureError = '', exited = false;
    watcher.on('error', (error) => { captureError = error.message; exited = true; });
    watcher.on('close', () => { exited = true; });
    watcher.stderr.on('data', (data) => { captureError += data; });
    lines.on('line', (line) => {
      try { latest = JSON.parse(line); frame += 1; }
      catch { captureError = 'Invalid live capture output'; }
    });
    async function liveSample() {
      await delay(500);
      const previousFrame = frame;
      const deadline = Date.now() + 5000;
      while (frame === previousFrame && !exited && Date.now() < deadline) await delay(50);
      if (exited || frame === previousFrame) throw new Error(captureError.trim() || 'Timed out waiting for a fresh live capture frame.');
      return latest;
    }
    results.push(await measureDisplay('SCStream/already-running-display', liveSample));
    lines.close();
    watcher.kill('SIGTERM');

    console.error('Testing SCScreenshotManager/single-window…');
    marker.setContentProtection(false);
    marker.showInactive();
    const displayControl = await sample(region);
    const selectedWindow = await sample(['--window', String(process.pid), title]);
    results.push({
      api: 'SCScreenshotManager/single-window', displayControl, selectedWindow,
      result: !mostlyRed(displayControl) ? 'inconclusive'
        : mostlyGray(selectedWindow) ? 'overlay-outside-selected-window' : 'inconclusive',
    });

    process.exitCode = results.some(({ result }) => result === 'inconclusive') ? 1
      : results.some(({ result }) => result === 'protected-overlay-visible') ? 2 : 0;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    if (results.length > 0) {
      console.log(JSON.stringify({ macOS: process.getSystemVersion(), electron: process.versions.electron, results }, null, 2));
    }
    clearTimeout(startupTimeout);
    watcher?.kill('SIGTERM');
    marker?.destroy();
    background?.destroy();
    app.exit(process.exitCode || 0);
  }
});
