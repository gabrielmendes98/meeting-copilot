const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const renderMarkdown = require('../src/overlay/markdown');

test('renders structured markdown and escapes raw html', () => {
  const html = renderMarkdown([
    '# Meeting notes',
    '',
    'Answer **directly** and *briefly*.',
    '',
    '- Confirm the date',
    '- [x] Send the recap',
    '- [ ] Draft follow-ups',
    '',
    '1. First owner',
    '2. Second owner',
    '',
    '> Ship it Friday',
    '',
    '| Topic | Owner |',
    '| --- | --- |',
    '| Launch | Ada |',
    '',
    '```js',
    'const ready = true;',
    '```',
    '',
    'See [the doc](https://example.com/notes) and ignore [bad](javascript:alert(1)).',
    '',
    '<script>alert(1)</script>',
    '![diagram](https://example.com/x.png)',
  ].join('\n'));

  assert.match(html, /<h1>Meeting notes<\/h1>/);
  assert.match(html, /<strong>directly<\/strong>/);
  assert.match(renderMarkdown('***both***'), /<strong><em>both<\/em><\/strong>/);
  assert.match(html, /<em>briefly<\/em>/);
  assert.match(html, /<ul><li>Confirm the date<\/li><li class="task done">Send the recap<\/li><li class="task">Draft follow-ups<\/li><\/ul>/);
  assert.match(html, /<ol><li>First owner<\/li><li>Second owner<\/li><\/ol>/);
  assert.match(html, /<blockquote><p>Ship it Friday<\/p><\/blockquote>/);
  assert.match(html, /<th>Topic<\/th>.*<td>Ada<\/td>/s);
  assert.match(html, /<pre data-lang="js"><code>const ready = true;<\/code><\/pre>/);
  assert.match(html, /<span class="md-link">the doc<\/span>/);
  assert.match(html, /\[bad\]\(javascript:alert\(1\)\)/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /diagram/);
  assert.doesNotMatch(html, /<script|href=|src=|onerror=/i);
});

test('keeps an unfinished fence readable while a reply is streaming', () => {
  const html = renderMarkdown('```\nconst value = 1;');
  assert.match(html, /<pre><code>const value = 1;<\/code><\/pre>/);
});

test('overlay paints markdown into the reply', () => {
  const elements = new Map();
  function element(id) {
    const el = {
      id, textContent: '', innerHTML: '', hidden: false, dataset: {},
      style: { setProperty() {}, maxHeight: '' },
      scrollTop: 0, scrollHeight: 40, clientHeight: 40, scrollBy() {},
      parentElement: { title: 'Shortcut', setAttribute() {} },
      setAttribute() {},
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    };
    elements.set(id, el);
    return el;
  }
  let handler;
  vm.runInNewContext(`${fs.readFileSync('src/overlay/markdown.js', 'utf8')}\n${fs.readFileSync('src/overlay/overlay.js', 'utf8')}`, {
    window: {
      copilot: { onState(fn) { handler = fn; }, onScroll() {}, resize() {} },
      addEventListener() {},
    },
    document: { getElementById: (id) => elements.get(id) || element(id) },
    requestAnimationFrame(fn) { fn(); },
  });
  handler({ status: 'answer', text: '## Next step\n\n- **Ship** the <b>notes</b>', opacity: 0.8, stealth: false, shortcuts: {} });
  const html = elements.get('text').innerHTML;
  assert.match(html, /<h2>Next step<\/h2>/);
  assert.match(html, /<strong>Ship<\/strong>/);
  assert.match(html, /&lt;b&gt;notes&lt;\/b&gt;/);
  assert.equal(elements.get('card').dataset.status, 'answer');
});
