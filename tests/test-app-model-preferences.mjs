import test from 'node:test';
import assert from 'node:assert/strict';
import {installCapabilities} from '../capabilities.mjs';
test('AI preferences come from private per-app choices, never web arguments or another app',async()=>{
 const listeners=new Map(),replies=new Map(),requests=[];
 const state={appGrants:{one:{ai:true},two:{ai:true}},appModelPreferences:{one:{modelKey:'configured-model',thinkingLevel:'low'}}};
 const api={on:(name,handler)=>listeners.set(name,handler),storage:{get:(key,fallback)=>state[key]??fallback},services:{invoke:async(service,method,args)=>{
  if(service==='hosted_apps'&&method==='reply'){replies.set(args.requestId,args);return {};}
  if(service==='model_access'){requests.push({method,args});return {supported:true};}
  throw new Error('Unexpected service');
 }}};
 const close=installCapabilities(api,{project:async()=>({definition:{capabilities:{ai:true,tools:[],networkOrigins:[]}}})});
 async function call(id,method,args){const requestId=crypto.randomUUID();await listeners.get('hosted_apps.request')({requestId,app:{id},method,args});for(let i=0;i<20&&!replies.has(requestId);i++)await new Promise(resolve=>setImmediate(resolve));assert.equal(replies.get(requestId)?.ok,true);return requests.findLast(r=>r.method!=='catalog');}
 try{
  assert.deepEqual((await call('one','ai.selection',{})).args.preference,state.appModelPreferences.one);
  assert.deepEqual((await call('two','ai.selection',{})).args.preference,{});
  const request=await call('one','ai.complete',{preference:{modelKey:'attacker',thinkingLevel:'high'},context:{messages:[]},expected:{}});
  assert.deepEqual(request.args.preference,state.appModelPreferences.one);assert.equal(request.args.caller,'one');
  assert.deepEqual(state.appModelPreferences,{one:{modelKey:'configured-model',thinkingLevel:'low'}});
 }finally{await close();}
});
test('thinking changes require a native picker and stay scoped; cancel preserves preferences',async()=>{
 const listeners=new Map(),replies=new Map();let choice='Thinking: high';
 const state={appGrants:{one:{ai:true}},appModelPreferences:{one:{modelKey:'model',thinkingLevel:'low'},two:{thinkingLevel:'off'}}};
 const api={on:(name,handler)=>listeners.set(name,handler),storage:{get:(key,fallback)=>state[key]??fallback,set:(key,value)=>state[key]=value},host:{invoke:async(method,args)=>{assert.equal(method,'pi_extension_select');assert.deepEqual(args.options,['Follow Aether','Thinking: low','Thinking: high']);return {value:choice};}},services:{invoke:async(service,method,args)=>{
  if(service==='hosted_apps'){replies.set(args.requestId,args);return {};}
  if(method==='catalog')return {models:[{key:'model',label:'Configured',thinkingLevels:['low','high']}]};
  return {supported:true,thinkingLevel:args.preference.thinkingLevel||'low',selectionId:'exact'};
 }}};
 const close=installCapabilities(api,{project:async()=>({definition:{capabilities:{ai:true}}})});
 async function call(){const requestId=crypto.randomUUID();await listeners.get('hosted_apps.request')({requestId,app:{id:'one'},method:'ai.configure',args:{thinkingLevel:'attacker',appId:'two'}});for(let i=0;i<50&&!replies.has(requestId);i++)await new Promise(resolve=>setImmediate(resolve));assert.equal(replies.get(requestId)?.ok,true);return replies.get(requestId).result;}
 try{assert.equal((await call()).thinkingLevel,'high');assert.equal(state.appModelPreferences.one.thinkingLevel,'high');assert.equal(state.appModelPreferences.two.thinkingLevel,'off');choice=undefined;await call();assert.equal(state.appModelPreferences.one.thinkingLevel,'high');choice='Follow Aether';await call();assert.deepEqual(state.appModelPreferences.one,{modelKey:'model'});}finally{await close();}
});
test('a warmed thinking picker opens before storage or model lookups; cancel writes nothing',async()=>{
 const handlers=new Map(),replies=new Map(),events=[];
 const state={appGrants:{one:{ai:true}},appModelPreferences:{one:{modelKey:'model'}}};
 const api={on:(name,handler)=>handlers.set(name,handler),storage:{get:(key,fallback)=>state[key]??fallback,set:()=>{throw Error('Cancel must not save');}},host:{invoke:async(method,args)=>{events.push('picker');assert.match(args.title,/Test model/);return {}; }},services:{invoke:async(service,method,args)=>{
  if(service==='hosted_apps'){replies.set(args.requestId,args);return {};}
  events.push(method);
  return method==='catalog'?{models:[{key:'model',thinkingLevels:['low'] }]}:{supported:true,model:{id:'test',name:'Test model'},thinkingLevel:'low',selectionId:'same'};
 }}};
 const close=installCapabilities(api,{project:async()=>{events.push('project');return {definition:{capabilities:{ai:true}}};}});
 async function call(method){const requestId=crypto.randomUUID();handlers.get('hosted_apps.request')({requestId,app:{id:'one'},method,args:{}});for(let i=0;i<100&&!replies.has(requestId);i++)await new Promise(resolve=>setImmediate(resolve));assert.equal(replies.get(requestId)?.ok,true);}
 try{await call('ai.selection');events.length=0;await call('ai.configure');assert.deepEqual(events,['picker']);}finally{await close();}
});
