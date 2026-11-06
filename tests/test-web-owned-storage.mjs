import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {LocalDocuments} from './test-support/local-documents.mjs';
import {ScopedFiles} from './test-support/scoped-files.mjs';
import {ProjectFileStore} from '../sdk/project-file-store.mjs';
test('actual web record implementation streams files, detects edits/tampering, and rejects root changes without extension storage',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'aether-web-records-')),io=new LocalDocuments(root),files=new ScopedFiles(io);
 let tamper=false;
 globalThis.AetherHosted={postMessage(text){const request=JSON.parse(text);void files.invoke(request.op,request.args).then(result=>{
  if(tamper&&request.op==='files.readFile'&&result.base64)result={...result,version:'0'.repeat(64)};
  this.onmessage({data:JSON.stringify({id:request.id,ok:true,result})});
 },error=>this.onmessage({data:JSON.stringify({id:request.id,ok:false,error:error.message})}));}};
 const store=new ProjectFileStore('test',{json:8*1048576,blob:32*1048576});
 try{
  await store.put('state','preferences',{size:2});assert.deepEqual(await store.get('state','preferences'),{size:2});
  const blob=new Blob([new Uint8Array(700000).fill(37)],{type:'application/pdf'});
  await store.put('document','sample',blob);assert.equal((await store.get('document','sample')).size,blob.size);assert.equal(io.readers.size,0);
  await Promise.all(Array.from({length:50},()=>store.get('state','preferences')));assert.equal(files.sessions.size,0,'completed read waves release sessions');
  await store.batch(Array.from({length:16},(_,i)=>({kind:'state',id:'batch'+i,value:{i}})));
  const index=(await io.json('aether-lidl-food/data/test/index.json')).value,entry=index.entries['state:preferences'];
  await io.write(entry.file,JSON.stringify({size:9}),entry.version);
  await assert.rejects(store.put('state','preferences',{size:3}),/changed/);
  assert.deepEqual((await io.json(entry.file)).value,{size:9});
  tamper=true;await assert.rejects(store.get('document','sample'),/hash check/);tamper=false;
  const stage=await store.stage('state','new',{ok:true});files.rootIdentity='fixture:new-root';
  await assert.rejects(store.request('commit',{entries:[stage]}),/folder changed/);
  await store.request('cancelWrite',{transfer:stage.transfer}).catch(()=>{});
  assert.equal((await io.json('aether-lidl-food/data/test/index.json')).value.entries['state:new'],undefined);
  assert.ok(files.calls.every(op=>op.startsWith('files.')));
 }finally{store.channel?.close();await files.close();delete globalThis.AetherHosted;await fs.rm(root,{recursive:true,force:true});}
});
