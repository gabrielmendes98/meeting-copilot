const { execFileSync } = require('node:child_process');
const path = require('node:path');

function signingPlan(output, requested, temporary = false) {
  if (temporary) return { identity: '-', type: 'distribution', temporary: true };
  const identities = [...output.matchAll(/^\s*\d+\)\s+([A-Fa-f0-9]{40})\s+"([^"]+)"/gm)]
    .map(([, hash, name]) => ({ hash, name }))
    .filter(({ name }) => /^(Developer ID Application|Apple Development|Mac Developer):/.test(name));
  const matches = requested ? identities.filter(({ hash, name }) => hash.toLowerCase() === requested.toLowerCase() || name === requested) : identities;
  if (!matches.length) throw new Error(requested
    ? 'The requested signing certificate is unavailable. Install it with its private key, or choose another certificate with MEETING_COPILOT_SIGNING_IDENTITY.'
    : 'No stable signing certificate is installed. In Xcode Settings → Accounts → Manage Certificates, create an Apple Development certificate, then retry. Temporary signing changes the app identity on updates and can leave Screen Recording enabled but unusable. To explicitly accept that limitation, use npm run package:mac:local.');
  if (matches.length > 1) throw new Error('Multiple signing certificates are available. Set MEETING_COPILOT_SIGNING_IDENTITY to the exact certificate name or SHA-1 hash so updates keep the same identity.');
  const selected = matches[0];
  return { identity: selected.hash, type: selected.name.startsWith('Developer ID Application:') ? 'distribution' : 'development', temporary: false };
}

function buildArguments(plan) {
  return ['--mac', 'dir', '-c.directories.output=release', `-c.mac.identity=${plan.identity}`,
    `-c.mac.type=${plan.type}`, `-c.forceCodeSigning=${!plan.temporary}`,
    '-c.mac.hardenedRuntime=false', '-c.electronDist=node_modules/electron/dist'];
}

function main() {
  if (process.platform !== 'darwin') throw new Error('Build this app on macOS.');
  const temporary = process.argv.includes('--temporary-signing');
  const output = temporary ? '' : execFileSync('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
  const plan = signingPlan(output, process.env.MEETING_COPILOT_SIGNING_IDENTITY?.trim() || process.env.CSC_NAME?.trim(), temporary);
  if (plan.temporary) console.warn('Temporary local signature: replacing the app may require removing and re-adding its Screen & System Audio Recording entry in System Settings, then Quit & Reopen.');
  const env = { ...process.env, MEETING_COPILOT_SPEECH_SIGNING_IDENTITY: plan.identity };
  const options = { cwd: path.resolve(__dirname, '..'), stdio: 'inherit', env };
  execFileSync('npm', ['run', 'build'], options);
  execFileSync(process.execPath, [require.resolve('electron-builder/cli.js'), ...buildArguments(plan)], options);
}

module.exports = { signingPlan, buildArguments };
if (require.main === module) {
  try { main(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
