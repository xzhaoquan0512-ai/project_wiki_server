import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execute=promisify(execFile);

test('source size setting stays bounded and invalid values fail before starting MCP', async () => {
  for(const value of ['0','65','NaN','2.5']) {
    await assert.rejects(execute(process.execPath,['bin/project-wiki-server.mjs','--help'],{env:{...process.env,PROJECT_WIKI_MAX_SOURCE_MIB:value}}),/PROJECT_WIKI_MAX_SOURCE_MIB/);
  }
});

test('configured 32 MiB accepts an intact 21 MiB PDF; default 20 rejects it', async () => {
  const script=`
import {mkdtemp,writeFile,realpath,rm} from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';import assert from 'node:assert/strict';
import {initializeVault} from './src/vault.mjs';import {SourceStore} from './src/lib/source-store.mjs';
import {connectLocal,callJson} from './src/client.mjs';
const parent=await realpath(os.tmpdir());const temp=await mkdtemp(path.join(parent,'wiki-large-source-'));
try {
 const root=await initializeVault(path.join(temp,'vault'));const store=new SourceStore(root);
 const stream='BT /F1 12 Tf 20 200 Td (Complete large PDF evidence) Tj ET';
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 400] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>','<< /Length '+Buffer.byteLength(stream)+' >>\\nstream\\n'+stream+'\\nendstream'];
 let pdf='%PDF-1.4\\n', offsets=[0];objects.forEach((value,index)=>{offsets.push(Buffer.byteLength(pdf));pdf+=(index+1)+' 0 obj\\n'+value+'\\nendobj\\n'});
 const xref=Buffer.byteLength(pdf);pdf+='xref\\n0 6\\n0000000000 65535 f \\n'+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \\n').join('')+'trailer\\n<< /Size 6 /Root 1 0 R >>\\nstartxref\\n'+xref+'\\n%%EOF\\n';
 const bytes=Buffer.alloc(21*1024*1024,32);Buffer.from(pdf).copy(bytes);await writeFile(path.join(root,'raw/large.pdf'),bytes);
 if(process.env.PROJECT_WIKI_MAX_SOURCE_MIB==='32') {
  const item=await store.registerSource({path:'raw/large.pdf'});assert.equal(item.bytes,bytes.length);
  const result=await store.readSource({reference:item.id,ocr:'off'});assert.match(result.pages[0].text,/Complete large PDF evidence/);
  const viaMcp=await initializeVault(path.join(temp,'mcp-vault'));
  const client=await connectLocal('wiki',viaMcp);
  try {
   const imported=await callJson(client,'wiki_import_source',{filename:'large.pdf',base64:bytes.toString('base64')});
   assert.equal(imported.bytes,bytes.length);assert.equal(imported.sha256,item.sha256);
   const evidence=await callJson(client,'wiki_read_source',{reference:imported.id,ocr:'off'});
   assert.match(evidence.pages[0].text,/Complete large PDF evidence/);
  }finally{await client.close()}
 } else await assert.rejects(store.registerSource({path:'raw/large.pdf'}),/20 MiB/);
}finally{const checked=await realpath(temp);if(path.dirname(checked)!==parent||!path.basename(checked).startsWith('wiki-large-source-'))throw Error('Unsafe cleanup');await rm(checked,{recursive:true})}
`;
  for(const value of ['20','32']) await execute(process.execPath,['--input-type=module','-e',script],{env:{...process.env,PROJECT_WIKI_MAX_SOURCE_MIB:value},timeout:60000,maxBuffer:100000});
});
