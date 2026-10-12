const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const productName = require('../package.json').productName;
const electronPath = require('electron');

function prepareMacApp() {
  const originalBundle = path.resolve(electronPath, '../../..');
  const originalPlist = path.join(originalBundle, 'Contents/Info.plist');
  const icon = path.join(root, 'build/icon.icns');
  const fingerprint = crypto.createHash('sha256')
    .update(fs.readFileSync(originalPlist))
    .update(fs.readFileSync(icon))
    .update(fs.readFileSync(__filename))
    .digest('hex').slice(0, 16);
  const cache = path.join(root, 'out/runtime', fingerprint);
  const bundle = path.join(cache, `${productName}.app`);
  const ready = path.join(cache, 'ready');
  if (!fs.existsSync(ready)) {
    fs.mkdirSync(cache, { recursive: true });
    fs.cpSync(originalBundle, bundle, { recursive: true, force: true, verbatimSymlinks: true });
    const plist = path.join(bundle, 'Contents/Info.plist');
    const fields = {
      CFBundleName: productName,
      CFBundleDisplayName: productName,
      CFBundleExecutable: productName,
      CFBundleIdentifier: 'dev.gabrielocc.meeting-copilot.dev',
      CFBundleIconFile: 'meeting-copilot.icns',
      LSApplicationCategoryType: 'public.app-category.productivity',
      NSScreenCaptureUsageDescription: 'Meeting Copilot captures system audio to transcribe meeting clips.',
      NSSpeechRecognitionUsageDescription: 'Meeting Copilot uses macOS speech recognition to transcribe English meeting audio.',
    };
    for (const [key, value] of Object.entries(fields)) {
      execFileSync('/usr/bin/plutil', ['-replace', key, '-string', value, plist]);
    }
    execFileSync('/usr/bin/plutil', ['-replace', 'LSUIElement', '-bool', 'false', plist]);
    const originalExecutable = path.basename(electronPath);
    const copiedExecutable = path.join(bundle, 'Contents/MacOS', originalExecutable);
    const brandedExecutable = path.join(bundle, 'Contents/MacOS', productName);
    if (fs.existsSync(copiedExecutable)) fs.renameSync(copiedExecutable, brandedExecutable);
    fs.copyFileSync(icon, path.join(bundle, 'Contents/Resources/meeting-copilot.icns'));
    // npm's Electron archive omits some resource signatures. Give the copied
    // runtime a complete local development signature, preserving entitlements.
    execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', '--identifier', fields.CFBundleIdentifier,
      '--preserve-metadata=entitlements,flags,runtime', bundle], { stdio: 'inherit' });
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], { stdio: 'inherit' });
    fs.writeFileSync(ready, `${productName}\n`);
  }
  return path.join(bundle, 'Contents/MacOS', productName);
}

function main() {
  const executable = process.platform === 'darwin' ? prepareMacApp() : electronPath;
  if (process.argv.includes('--prepare')) {
    console.log(`Ready: ${executable}`);
    return;
  }
  const child = spawn(executable, [root, ...process.argv.slice(2)], {
    cwd: root, stdio: 'inherit', env: process.env,
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1); });
}

try { main(); } catch (error) { console.error(`Could not prepare Meeting Copilot: ${error.message}`); process.exitCode = 1; }
