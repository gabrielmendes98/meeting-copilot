const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
  const elements = new Map();
  const queries = new Map();
  const calls = [];
  const timers = [];
  function element() {
    return { value:'',textContent:'',hidden:false,disabled:false,children:[],dataset:{},listeners:{},
      addEventListener(name, handler) { this.listeners[name] = handler; },
      replaceChildren(...children) { this.children = children; }, append(...children) { this.children.push(...children); },
      focus() { this.focused = true; }, querySelector() { return element(); }, querySelectorAll() { return []; },
    };
  }
  const get = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  const query = selector => { if (!queries.has(selector)) queries.set(selector, element()); return queries.get(selector); };
  const api = {
    onNewChat() {}, onAskShortcut() {}, onOpenPage() {}, onHistoryChanged() {}, onState() {}, onModeChanged() {},
    async getState() { return {}; }, async listModes() { return {selected:'general',modes:[]}; },
    async listMeetings(search) { calls.push(['list',search]); return []; },
    async getMeeting(id) { calls.push(['get',id]); return {id,title:'Planning',notes:'Decision made.',transcript:'Ship Friday.'}; },
    async askHistory(...args) { calls.push(['ask',...args]); return 'A grounded answer'; },
    async clearChat() { calls.push(['clear']); },
  };
  vm.runInNewContext(fs.readFileSync('src/application/workflows.js','utf8'), {
    $:get,api,document:{createElement:element,querySelector:query},
    Option:function(title,id){this.textContent=title;this.value=id;},
    notify(message) { calls.push(['error',message]); },showPage(page) {calls.push(['page',page]);},
    setInterval(){},setTimeout(fn){timers.push(fn);return timers.length;},clearTimeout(){},window:{confirm:()=>true},
  });
  return {get,query,api,calls,runSearch:async value => {
    get('meeting-search').value = value;
    get('meeting-search').listeners.input();
    await timers.at(-1)();
  }};
}

test('History search offers an AI question even without text matches, and Enter opens a result only after current results arrive', async () => {
  const f = fixture(); await flush();
  await f.runSearch('What did we decide?');
  assert.equal(f.get('history-ask-query').hidden,false);
  assert.equal(f.get('history-ask-query-label').textContent,'Ask “What did we decide?”');
  assert.equal(f.get('meeting-list').children[0].textContent,'No sessions match that search.');
  assert.equal(f.get('history-open-result').disabled,true);
  await f.get('history-ask-query').listeners.click();
  assert.deepEqual(f.calls.find(call=>call[0]==='ask'),['ask',null,'What did we decide?','']);
  assert.equal(f.get('history-answer').textContent,'A grounded answer');
  let resolve;
  f.api.listMeetings = () => new Promise(done=>{resolve=done;});
  const pending = f.runSearch('Planning');
  f.get('history-search-form').listeners.submit({preventDefault(){}});
  assert.equal(f.calls.some(call=>call[0]==='get'),false);
  resolve([{id:'meeting1',title:'Planning',startedAt:1000,endedAt:121000,hasNotes:true}]); await pending;
  assert.equal(f.get('history-open-result').disabled,false);
  f.get('history-search-form').listeners.submit({preventDefault(){}}); await flush();
  assert.deepEqual(f.calls.find(call=>call[0]==='get'),['get','meeting1']);
  assert.equal(f.get('meeting-title').value,'Planning');
  assert.equal(f.get('meeting-transcript').textContent,'Ship Friday.');
  await f.get('history-new-chat').listeners.click();
  assert.deepEqual(f.calls.slice(-2),[['clear'],['page','meeting']]);
});

test('History discards out-of-order search results and answers from an earlier query', async () => {
  const f = fixture(); await flush();
  const pending = new Map();
  f.api.listMeetings = query => new Promise(resolve=>pending.set(query,resolve));
  const old = f.runSearch('old');
  const latest = f.runSearch('new');
  pending.get('new')([{id:'new',title:'New meeting',startedAt:1000,endedAt:61000}]); await latest;
  pending.get('old')([{id:'old',title:'Old meeting',startedAt:1000,endedAt:61000}]); await old;
  assert.equal(f.get('meeting-list').children[0].children[0].textContent,'New meeting');
  let answer;
  f.api.askHistory = () => new Promise(resolve=>{answer=resolve;});
  const ask = f.get('history-ask-query').listeners.click();
  const empty = f.runSearch(''); pending.get('')([]); await empty;
  answer('An outdated answer'); await ask;
  assert.equal(f.get('history-answer').hidden,true);
  assert.equal(f.get('history-ask-query').hidden,true);
  assert.match(f.get('meeting-list').children[0].textContent,/No sessions yet/);
});
