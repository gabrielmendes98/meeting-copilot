const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function fixture() {
  const elements = new Map();
  function element() {
    return {value:'',textContent:'',hidden:false,children:[],listeners:{},classList:{toggle(){},add(){}},
      addEventListener(name,fn){this.listeners[name]=fn;},append(...children){this.children.push(...children);},
      replaceChildren(...children){this.children=children;},setAttribute(){},
    };
  }
  const get = id => {if(!elements.has(id))elements.set(id,element());return elements.get(id);};
  const fields = get('settings-form').elements = { STT_PROVIDER:element(),AGENT_PROVIDER:element(),AGENT_MODEL:element() };
  fields.AGENT_PROVIDER.value='openai';
  const api={onState(){},async getState(){throw new Error('model-only fixture');},async listContext(){return[];},async getContextText(){return'';}};
  const sandbox={window:{meetingCopilot:api},document:{getElementById:get,querySelectorAll:()=>[],createElement:element},setTimeout(){},clearTimeout(){}};
  vm.runInNewContext(fs.readFileSync('src/application/app.js','utf8')+'\nglobalThis.populate=populateModels;globalThis.selected=selectedModel;',sandbox);
  return {get,fields,populate:sandbox.populate,selected:sandbox.selected};
}

test('model choices include modern text-and-image options while preserving existing selections and provider-specific choices', () => {
  const f=fixture();
  f.populate('openai','gpt-4.1-mini');
  for(const id of ['gpt-6.2-sol','gpt-6.1-terra','gpt-6-luna','gpt-6.2-astra','gpt-5.4-mini','gpt-4.1-mini']) {
    assert.ok(f.fields.AGENT_MODEL.children.some(option=>option.value===id),id);
  }
  assert.equal(f.fields.AGENT_MODEL.value,'gpt-4.1-mini');
  f.fields.AGENT_MODEL.value='gpt-6.2-astra';f.fields.AGENT_MODEL.listeners.change();
  assert.match(f.get('model-hint').textContent,/higher cost/);
  assert.equal(f.get('custom-model-field').hidden,true);
  f.fields.AGENT_PROVIDER.value='cursor';f.fields.AGENT_PROVIDER.listeners.change();
  assert.equal(f.fields.AGENT_MODEL.value,'composer-2.5');
  assert.equal(f.fields.AGENT_MODEL.children.some(option=>option.value==='gpt-6.2-sol'),false);
  f.fields.AGENT_PROVIDER.value='openai';f.fields.AGENT_PROVIDER.listeners.change();
  assert.equal(f.fields.AGENT_MODEL.value,'gpt-6.2-astra');
  f.populate('openai','my-private-snapshot');
  assert.equal(f.get('custom-model-field').hidden,false);
  assert.equal(f.selected(),'my-private-snapshot');
});
