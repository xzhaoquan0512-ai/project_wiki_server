// Dedicated, bounded PDF indexing process. It never evaluates document actions or opens URLs.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs';
import {safePath,sha256,atomicWrite} from './vault-io.mjs';
import {MAX_SOURCE_BYTES} from './source-limits.mjs';
const [root,relative,expected,generation]=process.argv.slice(2);
if(!/^[a-f0-9]{64}$/.test(expected||'')||!/^generation-[a-f0-9-]+$/.test(generation||''))throw Error('Invalid index identity');
const source=await safePath(root,relative);
if((await fs.stat(source)).size>MAX_SOURCE_BYTES)throw Error('Source size exceeds configured limit');
const bytes=await fs.readFile(source);if(bytes.length>MAX_SOURCE_BYTES)throw Error('Source size exceeds configured limit');if(sha256(bytes)!==expected)throw Error('Source changed before indexing');
const base=`.wiki-server/fulltext/${expected}/${generation}`;
const asset=path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
const loading=getDocument({data:Uint8Array.from(bytes),isEvalSupported:false,disableFontFace:true,useSystemFonts:false,stopAtErrors:true,verbosity:0,cMapUrl:asset+'/cmaps/',cMapPacked:true,standardFontDataUrl:asset+'/standard_fonts/',maxImageSize:16000000,canvasMaxAreaInBytes:64000000});
const doc=await loading.promise;
try {
 if(doc.numPages>2000)throw Error('PDF exceeds 2000 pages');
 const units=[];let total=0;
 for(let number=1;number<=doc.numPages;number++){
  const page=await doc.getPage(number);let text='',truncated=false;
  const reader=page.streamTextContent().getReader();let complete=false;
  try {while(true){const {done,value}=await reader.read();if(done){complete=true;break;}
   for(const item of value.items){if(typeof item.str!=='string')continue;text+=item.str+(item.hasEOL?'\n':' ');if(text.length>200000){text=text.slice(0,200000);truncated=true;break;}}
   if(truncated)break;
  }}finally{if(!complete)await reader.cancel();reader.releaseLock();page.cleanup();}
  text=text.trimEnd();total+=Buffer.byteLength(text);if(total>64*1024*1024)throw Error('Extracted text exceeds 64 MiB document limit');
  const unit={page:number,text,method:'text_layer',truncated,needs_visual:text.replace(/\s/g,'').length<20||truncated};
  const data=JSON.stringify(unit);await atomicWrite(root,`${base}/${number}.json`,data);
  units.push({page:number,sha256:sha256(data),chars:text.length,truncated,needs_visual:unit.needs_visual});
 }
 const outline=[];
 async function walk(nodes,depth=0){if(depth>16)return;for(const item of nodes||[]){if(outline.length>=20000)throw Error('Outline exceeds item limit');
  let page=null;try{const dest=typeof item.dest==='string'?await doc.getDestination(item.dest):item.dest;if(dest)page=(Number.isInteger(dest[0])?dest[0]:await doc.getPageIndex(dest[0]))+1;}catch{}
  outline.push({title:String(item.title||'').slice(0,500),depth,page});await walk(item.items,depth+1);
 }}await walk(await doc.getOutline());
 const manifest={version:1,source_hash:expected,source_path:relative,generation,page_count:doc.numPages,text_bytes:total,units,outline,extracted_at:new Date().toISOString(),semantic_status:'pending',layout_warning:'Text extraction may omit diagrams, tables and formulas; this is not semantic review.'};
 await atomicWrite(root,`${base}/manifest.json`,JSON.stringify(manifest));
 console.log(JSON.stringify({page_count:doc.numPages,manifest:`${base}/manifest.json`}));
}finally{await doc.destroy()}
