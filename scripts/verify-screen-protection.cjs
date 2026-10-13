// Run with Electron, passing a compiled native/screen-protection-check helper.
// Creates only temporary test windows; never records or saves desktop imagery.
const { app, BrowserWindow, screen } = require('electron');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const helper = process.argv[2];
let background, marker, watcher;
app.setName('Meeting Copilot Capture Check');
app.whenReady().then(async () => {
  try {
    if (process.platform !== 'darwin' || !helper) throw new Error('Pass the compiled macOS capture-check helper.');
    app.setActivationPolicy('accessory'); app.dock?.hide();
    const display = screen.getPrimaryDisplay();
    const x = display.workArea.x + 24, y = display.workArea.y + 24;
    const options = { x, y, width: 320, height: 180, frame: false, show: false, focusable: false, skipTaskbar: true, alwaysOnTop: true, hasShadow: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } };
    background = new BrowserWindow({ ...options, backgroundColor: '#202020' });
    marker = new BrowserWindow({ ...options, transparent: true, backgroundColor: '#00000000' });
    for (const window of [background, marker]) { window.setAlwaysOnTop(true, 'screen-saver'); window.setIgnoreMouseEvents(true); window.setHiddenInMissionControl(true); }
    await background.loadURL('data:text/html,<body style="margin:0;background:%23202020"></body>');
    await marker.loadURL('data:text/html,<body style="margin:0;background:%23ff0000"></body>');
    const waitFrame = () => new Promise(resolve => setTimeout(resolve, 500));
    async function sample(stream = false) {
      await waitFrame();
      const { stdout } = await execute(helper, [String(x + 100 - display.bounds.x), String(y + 50 - display.bounds.y), '100', '80', ...(stream ? ['--stream'] : [])], { timeout: 20_000 });
      return JSON.parse(stdout);
    }
    const results = [];
    for (const stream of [false, true]) {
      marker.hide(); marker.setContentProtection(false); background.showInactive();
      const baseline = await sample(stream);
      marker.showInactive();
      const unprotected = await sample(stream);
      marker.setContentProtection(true);
      const protectedCapture = await sample(stream);
      const valid = baseline.grayRatio > 0.9 && unprotected.redRatio > 0.9;
      const excluded = valid && protectedCapture.grayRatio > 0.9 && protectedCapture.redRatio < 0.05;
      results.push({ api: stream ? 'SCStream' : 'SCScreenshotManager', baseline, unprotected, protectedCapture, result: !valid ? 'inconclusive' : excluded ? 'excluded-in-this-test' : 'protected-overlay-visible' });
    }
    marker.hide(); marker.setContentProtection(false); background.showInactive();
    watcher = spawn(helper, [String(x + 100 - display.bounds.x), String(y + 50 - display.bounds.y), '100', '80', '--watch'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let latest, output = '', captureError = '', exited = false;
    watcher.on('error', error => { captureError = error.message; exited = true; });
    watcher.on('exit', () => { exited = true; });
    watcher.stderr.on('data', data => { captureError += data; });
    watcher.stdout.on('data', data => {
      output += data;
      let end;
      while ((end = output.indexOf('\n')) >= 0) {
        const line = output.slice(0, end); output = output.slice(end + 1);
        try { latest = JSON.parse(line); } catch { captureError = 'Invalid live capture output'; }
      }
    });
    const deadline = Date.now() + 20_000;
    while (!latest && !exited && Date.now() < deadline) await waitFrame();
    async function liveSample() { await waitFrame(); if (exited || !latest) throw new Error(captureError || 'Live capture unavailable'); return latest; }
    const baseline = await liveSample();
    marker.showInactive(); const unprotected = await liveSample();
    marker.setContentProtection(true); const protectedCapture = await liveSample();
    const valid = baseline.grayRatio > 0.9 && unprotected.redRatio > 0.9;
    const excluded = valid && protectedCapture.grayRatio > 0.9 && protectedCapture.redRatio < 0.05;
    results.push({ api: 'SCStream-already-running', baseline, unprotected, protectedCapture, result: !valid ? 'inconclusive' : excluded ? 'excluded-in-this-test' : 'protected-overlay-visible' });
    console.log(JSON.stringify({ macOS: process.getSystemVersion(), electron: process.versions.electron, results }, null, 2));
    process.exitCode = results.every(result => result.result === 'excluded-in-this-test') ? 0 : results.some(result => result.result === 'inconclusive') ? 1 : 2;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { watcher?.kill('SIGTERM'); marker?.destroy(); background?.destroy(); app.exit(process.exitCode || 0); }
});
