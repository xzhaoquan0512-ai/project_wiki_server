import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createWikiServer } from '../src/wiki-server.mjs';
import { initializeVault } from '../src/vault.mjs';
import { SourceStore } from '../src/lib/source-store.mjs';
import { NoteStore } from '../src/lib/note-store.mjs';
import { FulltextStore } from '../src/lib/fulltext-store.mjs';
import { CompilationStore, compilationProgress, sourceTasks } from '../src/lib/compilation-store.mjs';
import { boundedResponse, responsePage } from '../src/lib/response-pages.mjs';
import { projectObservation } from '../src/lib/project-observation.mjs';
import { evidenceSchema } from '../src/lib/evidence-contract.mjs';
import { ProjectAdapter } from '../src/lib/project-adapter.mjs';
import { saveMaintenanceStatus, maintenanceStatus } from '../src/lib/maintenance-status.mjs';

async function fixture(t) {
  const base=await realpath(os.tmpdir()), dir=await mkdtemp(path.join(base,'wiki-gap-test-'));
  t.after(async()=>{const resolved=await realpath(dir);assert.equal(path.dirname(resolved),base);assert.ok(path.basename(resolved).startsWith('wiki-gap-test-'));await rm(resolved,{recursive:true});});
  return {dir,root:await initializeVault(path.join(dir,'vault'))};
}
async function connect(t,root) {
  const server=await createWikiServer(root), client=new Client({name:'gap-test',version:'1'});
  const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);
  t.after(async()=>{await client.close();await server.close();});
  return async(name,args={})=>{const r=await client.callTool({name,arguments:args});if(r.isError)throw Error(r.content[0].text);return r.content[0]?.type==='image'?r:JSON.parse(r.content[0].text);};
}

test('both note views continue through the raw tail and reject a changed revision',async t=>{
  const {root}=await fixture(t),call=await connect(t,root),body='12345😀\n'.repeat(400);
  await call('wiki_write_note',{category:'concepts',title:'Long',content:body});
  const original=await new NoteStore(root).read('Long');let offset=0,content='',raw='';
  do {const r=await call('wiki_read_note',{pathOrTitle:'Long',view:'both',max_chars:1000,offset,expected_revision:original.revision});assert.ok(r.content.length+r.rawMarkdown.length<=1000);content+=r.content;raw+=r.rawMarkdown;offset=r.pagination.next_offset;}while(offset!==null);
  assert.equal(content,original.content);assert.equal(raw,original.rawMarkdown);
  await call('wiki_write_note',{category:'concepts',title:'Long',content:'new content',expected_revision:original.revision});
  await assert.rejects(call('wiki_read_note',{pathOrTitle:'Long',offset:1000,expected_revision:original.revision}),/REVISION_CONFLICT/);
});

test('oversized metadata and pathological escaped strings have lossless bounded snapshots',async t=>{
  const {root}=await fixture(t),value={metadata:'\u0000"😀'.repeat(25000)};
  let r=JSON.parse((await boundedResponse(root,value)).content[0].text),text='';
  do {assert.ok(JSON.stringify(r).length<64000);text+=r.text;if(r.next_offset===null)break;r=await responsePage(root,{snapshot_id:r.snapshot_id,offset:r.next_offset});}while(true);
  assert.deepEqual(JSON.parse(text),value);
  await writeFile(path.join(root,'.wiki-server/responses',r.snapshot_id+'.json'),'tampered');
  await assert.rejects(responsePage(root,{snapshot_id:r.snapshot_id}),/Invalid/);
});

test('text and HTML become searchable units; new unit tasks do not inherit whole-source completion',async t=>{
  const {root}=await fixture(t),sources=new SourceStore(root),full=new FulltextStore(root);
  const text=await sources.importSource({filename:'plain.txt',text:'UniqueTextToken is indexed.'});
  const html=await sources.importSource({filename:'many.html',text:'<html><body>'+Array.from({length:45},(_,i)=>`<p>unit-${i} UniqueHtmlToken</p>`).join('')+'</body></html>'});
  await full.index();assert.equal((await full.search({query:'UniqueTextToken'})).entries[0].path,text.path);
  const hits=await full.search({query:'UniqueHtmlToken'});assert.ok(hits.total>=40);assert.ok(hits.entries[0].locator);
  const source=(await full.status({reference:html.id})).sources[0];assert.ok(source.unit_count>=40);
  const queue=await new CompilationStore(root).queue({status:'all',limit:100});assert.ok(queue.entries.some(e=>e.path===html.path&&e.start_unit===21));
  const records={[html.sha256+':source-source']:{status:'summarized',notes:[]}};
  const progress=await compilationProgress(root,records,html.sha256,{source});assert.equal(progress.semantic_status,'pending');assert.ok(progress.compilation_pending>=2);
  const first=sourceTasks(source)[0];records[first.id]={status:'summarized',notes:[]};
  assert.equal((await compilationProgress(root,records,html.sha256,{source})).semantic_status,'pending');
});

test('image OCR is indexed and MCP returns original image pixels with hash and crop',async t=>{
  const {createCanvas}=await import('@napi-rs/canvas');const c=createCanvas(1000,220);const ctx=c.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,1000,220);ctx.fillStyle='black';ctx.font='64px sans-serif';ctx.fillText('MOTOR BUFFER 1234',30,125);
  const {root}=await fixture(t),source=await new SourceStore(root).importSource({filename:'words.png',base64:c.toBuffer('image/png').toString('base64')});
  await new FulltextStore(root).index({languages:'eng'});
  const search=await new FulltextStore(root).search({query:'BUFFER'});assert.equal(search.total,1);assert.equal(search.entries[0].method,'ocr');
  const server=await createWikiServer(root),client=new Client({name:'render-test',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);
  try {const r=await client.callTool({name:'wiki_read_image',arguments:{reference:source.id,max_side:512,crop:{x:0,y:0,width:1,height:0.8}}});assert.ok(!r.isError);assert.equal(JSON.parse(r.content[0].text).sha256,source.sha256);assert.equal(r.content[1].type,'image');assert.deepEqual(Buffer.from(r.content[1].data,'base64').subarray(1,4),Buffer.from('PNG'));}finally{await client.close();await server.close();}
});

test('full evidence detects source edits and links to project notes without accepting padded short hashes',async t=>{
  const {root,dir}=await fixture(t),project={id:'demo',root:path.join(dir,'project')};await mkdir(project.root);execFileSync('git',['init',project.root],{stdio:'ignore'});
  await writeFile(path.join(project.root,'source.c'),'int value = 1;\n');
  const original=await projectObservation(project,'capture-evidence',{paths:['source.c']});assert.ok(evidenceSchema.safeParse(original).success);
  assert.equal((await projectObservation(project,'check-evidence',{evidence:original})).status,'unchanged');
  await writeFile(path.join(project.root,'source.c'),'int value = 2;\n');
  assert.equal((await projectObservation(project,'check-evidence',{evidence:original})).status,'needs_review');
  const call=await connect(t,root);await call('wiki_write_note',{category:'syntheses',title:'Evidence',content:'Draft scope only.',frontmatter:{provenance:[{project_id:'demo',scope:'source.c only',evidence:original}]}});
  assert.equal((await call('wiki_project_references',{project_id:'demo'})).entries[0].provenance[0].evidence.files[0].sha256,original.files[0].sha256);
  await assert.rejects(call('wiki_write_note',{category:'concepts',title:'Bad',content:'invalid',frontmatter:{provenance:[{project_id:'demo',scope:'test',hash:{algorithm:'sha256',value:'12345678'}}]}}));
});

test('handoff writes only cache files and retains caller event; arbitrary output paths are not exposed',async t=>{
  const {dir}=await fixture(t),root=path.join(dir,'project');await mkdir(root);await writeFile(path.join(root,'rule.md'),'rule');
  const calls=[];const adapter=new ProjectAdapter(new Map([['demo',{id:'demo',root,adapter:'context_session',python:'python',script:'tools/docs/context_session.py'}]]),async(command,args)=>{
    const summary=args.find(x=>x.startsWith('--summary-file='));if(summary){const p=summary.split('=')[1];assert.match(p,/^build\/docs\/mcp\/handoffs\//);calls.push(JSON.parse(await readFile(path.join(root,p),'utf8')));}
    calls.push(args);return {stdout:JSON.stringify({status:'passed',result:{}}),stderr:''};
  });
  const scope={project_id:'demo',session_id:'CTX-fixture'};
  await adapter.call('prepare',{...scope,goal:'Isolated handoff fixture',paths:['rule.md']});
  const summary={goal:'fixture',evidence:[{path:'rule.md',sha256:'12345678',locator:'line:1'}],decisions:[],open_questions:[],next_actions:['Continue fixture']};
  await adapter.call('checkpoint',{...scope,summary});assert.deepEqual(calls[1],summary);
  const written=calls[2].find(x=>x.startsWith('--summary-file=')).split('=')[1];await assert.rejects(readFile(path.join(root,written)),/ENOENT/);
  await adapter.call('resume',{...scope,context_event:'new-context',context_reason:'Isolated simulated fixture event; no real platform compaction claimed'});assert.ok(calls.at(-1).includes('--context-event=new-context'));
  await assert.rejects(adapter.call('checkpoint',{...scope,summary:{...summary,evidence:[{path:'../outside',sha256:'12345678',locator:'line:1'}]}}),/inside/);
});

test('maintenance status retains failures and verified backup receipt explicitly',async t=>{
  const {root}=await fixture(t);await saveMaintenanceStatus(root,'scan',{success:false,error:'fixture scan failure'});await saveMaintenanceStatus(root,'backup',{success:true,result:{restore_verified:true,sha256:'a'.repeat(64)}});
  const r=await maintenanceStatus(root);assert.equal(r.scan.receipt.success,false);assert.equal(r.backup.receipt.result.restore_verified,true);
});

function pdf() {
  const stream = 'BT /F1 12 Tf 20 350 Td (DMA buffer test evidence for indexing) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 400] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let text = '%PDF-1.4\n'; const offsets = [];
  for (const [i, object] of objects.entries()) { offsets.push(Buffer.byteLength(text)); text += `${i + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(text);
  text += `xref\n0 6\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(text);
}


test('PDF pixels are bounded and forced OCR retains separately searchable text layer',async t=>{
  const {root}=await fixture(t),source=await new SourceStore(root).importSource({filename:'render.pdf',base64:pdf().toString('base64')});
  const {renderSource}=await import('../src/lib/extractors/render.mjs');
  const image=await renderSource(pdf(),{kind:'pdf',page:1,max_side:512,crop:{x:0,y:0,width:1,height:0.5}});
  assert.equal(image.width,512);assert.equal(image.height,256);
  await assert.rejects(renderSource(pdf(),{kind:'pdf',page:2}),/range/);
  const full=new FulltextStore(root);await full.index({reference:source.id,ocr:'force',languages:'eng'});
  const found=await full.search({query:'buffer'});assert.ok(found.entries.some(e=>e.method==='text_layer'));assert.ok(found.entries.some(e=>e.method==='ocr'));
});

test('spreadsheets retain worksheet and cell locators in the unified index',async t=>{
  const XLSX=await import('xlsx');const book=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['AlphaOnlyToken'],['SecondRow']]),'Alpha');
  XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['BetaOnlyToken']]),'Beta');
  const {root}=await fixture(t);await new SourceStore(root).importSource({filename:'units.xlsx',base64:XLSX.write(book,{type:'base64',bookType:'xlsx'})});
  const full=new FulltextStore(root);await full.index();const result=await full.search({query:'BetaOnlyToken'});
  assert.equal(result.total,1);assert.match(JSON.stringify(result.entries[0].locator),/Beta/);assert.ok(result.entries[0].unit>=2);
});

test('long plain text has resumable unit ranges with lossless character and line locations',async t=>{
  const {root}=await fixture(t),body=('PlainChunk 😀\n').repeat(16000);
  const source=await new SourceStore(root).importSource({filename:'long.txt',text:body});
  const full=new FulltextStore(root);await full.index();
  const state=(await full.status({reference:source.id})).sources[0];assert.ok(state.unit_count>40);
  const ranges=sourceTasks(state);assert.ok(ranges.length>=3);assert.equal(ranges[1].start_unit,21);
  let offset=0,recovered='';for(const locator of state.unit_locators){assert.equal(locator.offset,offset);assert.ok(locator.end_offset-offset<=5000);recovered+=body.slice(offset,locator.end_offset);offset=locator.end_offset;}
  assert.equal(recovered,body);assert.equal(offset,body.length);
});

test('context code search uses fixed literal rg argv and preserves empty-result semantics',async t=>{
  const {dir}=await fixture(t),root=path.join(dir,'project');await mkdir(root);await mkdir(path.join(root,'src'));
  const seen=[];const adapter=new ProjectAdapter(new Map([['demo',{id:'demo',root,adapter:'context_session',python:'python',script:'tools/docs/context_session.py'}]]),async(command,args)=>{
    const request=args.find(a=>a.startsWith('--argv-file='));seen.push(JSON.parse(await readFile(path.join(root,request.slice(12)),'utf8')));
    throw Object.assign(Error('rg returned no matches'),{stdout:JSON.stringify({status:'failed',result:{exit_code:1,complete:true,stdout:{bytes:0}}}),stderr:'',code:1});
  });
  const scope={project_id:'demo',session_id:'CTX-fixture'};
  const result=await adapter.call('search-code',{...scope,query:'--literal $(text)',path_prefix:'src'});
  assert.equal(seen[0][0],'rg');assert.ok(seen[0].includes('--fixed-strings'));assert.deepEqual(seen[0].slice(-3),['--','--literal $(text)','src']);
  assert.equal(result.exit_code,0);assert.equal(result.backend.result.no_matches,true);assert.equal(result.backend.result.command_exit_code,1);
  await adapter.call('files',{...scope,query:'secret'});
  assert.ok(seen[1].indexOf('!*secret*')>seen[1].indexOf('*secret*'));
  assert.ok(seen[1].includes('!**/build/**'));assert.ok(seen[1].includes('!*.pem'));
  await assert.rejects(adapter.call('search-code',{...scope,query:'text',offset:1}),/generic-only/);
});
