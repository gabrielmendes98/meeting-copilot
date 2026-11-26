const { test } = require('node:test');
const assert = require('node:assert/strict');
const { signingPlan, buildArguments } = require('../scripts/package-mac.cjs');
const development = 'A'.repeat(40), distribution = 'B'.repeat(40);
const output = `  1) ${development} "Apple Development: Example (TEAM123)"\n  2) ${distribution} "Developer ID Application: Example (TEAM123)"\n     2 valid identities found`;

test('normal packaging refuses temporary signing and ambiguous identities', () => {
  assert.throws(() => signingPlan('0 valid identities found'), /No stable signing certificate/);
  assert.throws(() => signingPlan(output), /Multiple signing certificates/);
  assert.throws(() => signingPlan(output, 'missing certificate'), /requested signing certificate is unavailable/);
  assert.throws(() => signingPlan(`1) ${development} "Apple Distribution: Example"`), /No stable signing certificate/);
});

test('packaging selects the same explicit identity and correct signing type', () => {
  const plan = signingPlan(output, 'Apple Development: Example (TEAM123)');
  assert.deepEqual(plan, { identity: development, type: 'development', temporary: false });
  assert.deepEqual(signingPlan(output, development.toLowerCase()), plan);
  assert.equal(signingPlan(output, distribution).type, 'distribution');
  assert.equal(signingPlan(output.split('\n')[0]).identity, development);
  const args = buildArguments(plan);
  assert.ok(args.includes('-c.forceCodeSigning=true'));
  assert.ok(args.includes(`-c.mac.identity=${development}`));
  assert.ok(args.includes('-c.mac.type=development'));
  assert.ok(!args.includes('-c.mac.identity=-'));
});

test('temporary signing is an explicit separate packaging choice', () => {
  const plan = signingPlan('', undefined, true);
  assert.equal(plan.temporary, true);
  assert.ok(buildArguments(plan).includes('-c.mac.identity=-'));
  const scripts = require('../package.json').scripts;
  assert.equal(scripts['package:mac'], 'node scripts/package-mac.cjs');
  assert.match(scripts['package:mac:local'], /--temporary-signing/);
});
