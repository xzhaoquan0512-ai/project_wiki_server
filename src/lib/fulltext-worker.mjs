// Dedicated, bounded PDF indexing process. It never evaluates document actions or opens URLs.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs';
import {safePath,sha256,atomicWrite} from './vault-io.mjs';
import {sourceKind, readExtractedSource} from './source-extraction.mjs';
import {MAX_SOURCE_BYTES} from './source-limits.mjs';
const [root,relative,expected,generation,optionsText='{}']=process.argv.slice(2);
const options=JSON.parse(optionsText), ocr=options.ocr ?? 'auto', languages=options.languages ?? 'eng+chi_sim';
if(!/^[a-f0-9]{64}$/.test(expected||'')||!/^generation-[a-f0-9-]+$/.test(generation||''))throw Error('Invalid index identity');
const source=await safePath(root,relative);
if((await fs.stat(source)).size>MAX_SOURCE_BYTES)throw Error('Source size exceeds configured limit');
const bytes=await fs.readFile(source);if(bytes.length>MAX_SOURCE_BYTES)throw Error('Source size exceeds configured limit');if(sha256(bytes)!==expected)throw Error('Source changed before indexing');
const base=`.wiki-server/fulltext/${expected}/${generation}`;
const kind=sourceKind(relative,bytes);
if(kind !== 'pdf') {
 if(kind==='unsupported') throw Error('Unsupported fulltext source');
 const units=[];let total=0, cursor={}, complete=false;
 while(!complete) {
  const r=await readExtractedSource(root,{path:relative,sha256:expected},bytes,{...cursor,max_chars:50000,...(kind==='text'?{}:{unit_count:100}),...(['png','jpeg','webp','bmp','tiff'].includes(kind)?{languages}:{})});
  let pieces=r.units;
  if(r.format==='text') {
   pieces=[];let at=0,line=r.start_line;
   while(at<r.text.length) {
    let end=Math.min(at+5000,r.text.length);
    if(end<r.text.length&&/[\uD800-\uDBFF]/.test(r.text[end-1]))end--;
    const newline=r.text.lastIndexOf('\n',end-1);
    if(end<r.text.length&&newline>at+2500)end=newline+1;
    const text=r.text.slice(at,end),nextLine=line+(text.match(/\n/g)?.length??0);
    pieces.push({unit:units.length+pieces.length+1,text,locator:{kind:'text',offset:r.offset+at,end_offset:r.offset+end,start_line:line,end_line:nextLine},method:'decoded_text'});
    at=end;line=nextLine;
   }
  }
  for(const item of pieces){
   const index=(item.unit ?? 1)-1;
   if(index>9999)throw Error('Document exceeds 10000 indexed units');
   units[index]??={unit:index+1,text:'',locator:item.locator,method:item.method??r.format,warnings:r.warnings??[],truncated:false};
   units[index].text+=item.text;units[index].truncated||=Boolean(item.truncated||r.truncated);
   total+=Buffer.byteLength(item.text);if(total>64*1024*1024)throw Error('Extracted text exceeds 64 MiB');
  }
  if(r.format==='text'){complete=r.next_offset===null;cursor={offset:r.next_offset};}else{complete=!r.next;cursor=r.next;}
 }
 const references=[];
 for(const u of units){const data=JSON.stringify(u);await atomicWrite(root,`${base}/${u.unit}.json`,data);references.push({unit:u.unit,locator:u.locator,sha256:sha256(data),chars:u.text.length,truncated:u.truncated,needs_visual:u.method==='ocr'||u.truncated});}
 await atomicWrite(root,`${base}/manifest.json`,JSON.stringify({version:2,kind,unit_scheme:kind==='text'?'text-chunks-5000-v1':'parser-units-v1',source_hash:expected,source_path:relative,generation,page_count:0,unit_count:units.length,text_bytes:total,units:references,outline:[],options:{ocr,languages},extracted_at:new Date().toISOString()}));
 console.log(JSON.stringify({unit_count:units.length}));
 process.exit(0);
}
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
  let method='text_layer', warnings=[], text_layer;
  if(ocr==='force'||(ocr==='auto'&&text.replace(/\s/g,'').length<20)) {
   text_layer=text;let recognized='', offset=0;
   do {
    const result=await readExtractedSource(root,{path:relative,sha256:expected},bytes,{page:number,page_count:1,page_offset:offset,max_chars:50000,ocr,languages});
    const p=result.pages[0];recognized+=p.text;method=p.method;warnings=p.warnings??[];truncated||=Boolean(result.truncated);
    offset=result.next?.page===number?result.next.page_offset:null;
    if(recognized.length>200000){recognized=recognized.slice(0,200000);truncated=true;break;}
   }while(offset!==null);
   total+=Buffer.byteLength(recognized)-Buffer.byteLength(text);text=recognized;
   if(total>64*1024*1024)throw Error('Extracted text exceeds 64 MiB');
  }
  const unit={page:number,unit:number,locator:{kind:'page',page:number},text,text_layer,method,warnings,truncated,needs_visual:method==='ocr'||text.replace(/\s/g,'').length<20||truncated};
  const data=JSON.stringify(unit);await atomicWrite(root,`${base}/${number}.json`,data);
  units.push({page:number,unit:number,locator:{kind:'page',page:number},sha256:sha256(data),chars:text.length,truncated,needs_visual:unit.needs_visual});
 }
 const outline=[];
 async function walk(nodes,depth=0){if(depth>16)return;for(const item of nodes||[]){if(outline.length>=20000)throw Error('Outline exceeds item limit');
  let page=null;try{const dest=typeof item.dest==='string'?await doc.getDestination(item.dest):item.dest;if(dest)page=(Number.isInteger(dest[0])?dest[0]:await doc.getPageIndex(dest[0]))+1;}catch{}
  outline.push({title:String(item.title||'').slice(0,500),depth,page});await walk(item.items,depth+1);
 }}await walk(await doc.getOutline());
 const manifest={version:2,kind,options:{ocr,languages},unit_count:doc.numPages,source_hash:expected,source_path:relative,generation,page_count:doc.numPages,text_bytes:total,units,outline,extracted_at:new Date().toISOString(),semantic_status:'pending',layout_warning:'Text extraction may omit diagrams, tables and formulas; this is not semantic review.'};
 await atomicWrite(root,`${base}/manifest.json`,JSON.stringify(manifest));
 console.log(JSON.stringify({page_count:doc.numPages,manifest:`${base}/manifest.json`}));
}finally{await doc.destroy()}
