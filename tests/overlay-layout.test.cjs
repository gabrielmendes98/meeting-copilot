const { test } = require('node:test');
const assert = require('node:assert/strict');
const { constrainOverlay } = require('../dist/overlay-layout');

test('panel remains reachable on small displays and displays with negative origins', () => {
  assert.deepEqual(constrainOverlay({ x: 2000, y: 1000, width: 840, height: 300 }, { x: 0, y: 25, width: 1440, height: 875 }), { x: 600, y: 600, width: 840, height: 300 });
  assert.deepEqual(constrainOverlay({ x: -2000, y: -1200, width: 840, height: 140 }, { x: -1920, y: -1080, width: 1920, height: 1080 }), { x: -1920, y: -1080, width: 840, height: 140 });
  assert.deepEqual(constrainOverlay({ x: 100, y: 52, width: 840, height: 400 }, { x: 0, y: 0, width: 640, height: 300 }), { x: 0, y: 0, width: 640, height: 300 });
});
