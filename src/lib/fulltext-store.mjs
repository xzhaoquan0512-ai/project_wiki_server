import fs from 'node:fs/promises';import path from 'node:path';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {fileURLToPath} from 'node:url';import {randomUUID} from 'node:crypto';
import {SourceStore} from './source-store.mjs';
import {safePath,sha256,withVaultLock,readJson,writeJson} from './vault-io.mjs';
const execute=promisify(execFile);
const worker=fileURLToPath(new URL('./fulltext-worker.mjs',import.meta.url));
const CURRENT='.wiki-server/fulltext/catalog.json';
export class FulltextStore {
 constructor(root){this.root=root;this.sources=new SourceStore(root);}
 async inventory(){let entries=[],offset=0;do{const page=await this.sources.listSources({offset,limit:100});entries.push(...page.entries);offset=page.next_offset;}while(offset!==null);return entries;}
 async catalog(){const value=await readJson(this.root,CURRENT,{version:1,entries:[]});if(value.version!==1||!Array.isArray(value.entries))throw Error('Invalid fulltext catalog');return value;}
 async manifest(item){if(!/^[a-f0-9]{64}$/.test(item.source_hash)||!/^generation-[a-f0-9-]+$/.test(item.generation))throw Error('Invalid fulltext identity');
  const m=await readJson(this.root,`.wiki-server/fulltext/${item.source_hash}/${item.generation}/manifest.json`);
  if(m.version!==1||m.source_hash!==item.source_hash||m.generation!==item.generation||!Array.isArray(m.units)||!Number.isInteger(m.page_count)||m.page_count<1||m.page_count>2000||m.units.length!==m.page_count||!Array.isArray(m.outline)||m.outline.length>20000||m.units.some((u,i)=>u.page!==i+1||!/^[a-f0-9]{64}$/.test(u.sha256)))throw Error('Invalid fulltext manifest');return m;
 }
 async index({reference}={}){
  const catalog=await this.catalog();const all=await this.inventory();const results=[];
  for(const source of all){if(!source.registered||!source.path.toLowerCase().endsWith('.pdf'))continue;if(reference&&source.path!==reference&&source.id!==reference)continue;
   if(source.integrity!=='ok'){results.push({path:source.path,status:'source_problem',integrity:source.integrity});continue;}
   const present=(await this.catalog()).entries.find(e=>e.source_hash===source.sha256);
   if(present){const m=await this.manifest(present);await this.verifyUnits(present,m);results.push({path:source.path,status:'unchanged',pages:m.page_count});continue;}
   const generation='generation-'+randomUUID();
   const result=await execute(process.execPath,['--max-old-space-size=384',worker,this.root,source.path,source.sha256,generation],{timeout:1200000,maxBuffer:65536,windowsHide:true,env:process.env});
   const created={source_hash:source.sha256,source_path:source.path,generation};const m=await this.manifest(created);
   await withVaultLock(this.root,async()=>{
    if(sha256(await fs.readFile(await safePath(this.root,source.path)))!==source.sha256)throw Error('Source changed while indexing; new generation not published');
    const latest=await this.catalog();if(!latest.entries.some(e=>e.source_hash===source.sha256)){latest.entries.push(created);await writeJson(this.root,CURRENT,latest);}
   });results.push({path:source.path,status:'indexed',pages:m.page_count,needs_visual:m.units.filter(u=>u.needs_visual).length});
   process.stderr.write(`Indexed ${source.path}: ${m.page_count} pages\n`);
 }return {results,meaning:'All pages traversed does not mean all content semantically reviewed.'};
 }
 async verifyUnits(item,manifest){for(const unit of manifest.units){const data=await fs.readFile(await safePath(this.root,`.wiki-server/fulltext/${item.source_hash}/${item.generation}/${unit.page}.json`));if(sha256(data)!==unit.sha256)throw Error(`Fulltext cache integrity mismatch: ${item.source_path} page ${unit.page}`);}}
 async status({reference}={}){
  const catalog=await this.catalog();const all=await this.inventory();const output=[];
  for(const s of all){if(reference&&s.id!==reference&&s.path!==reference)continue;const e=catalog.entries.find(e=>e.source_hash===s.registered_sha256||e.source_hash===s.sha256);
   const m=e?await this.manifest(e):null;
   output.push({id:s.id,path:s.path,integrity:s.integrity||'unregistered',indexed:Boolean(m)&&s.integrity==='ok',page_count:m?.page_count||0,needs_visual_pages:m?.units.filter(u=>u.needs_visual).map(u=>u.page)||[],truncated_pages:m?.units.filter(u=>u.truncated).map(u=>u.page)||[],semantic_status:m?'pending':'not_started'});
  }return {sources:output,indexed_pages:output.filter(s=>s.indexed).reduce((n,s)=>n+s.page_count,0),semantic_warning:'Indexing and citations are not full semantic compilation or hardware verification.'};
 }
 async search({query,reference,offset=0,limit=10}){
  if(typeof query!=='string'||!query.trim()||query.length>1000)throw Error('query must be 1..1000 characters');
  if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>50)throw Error('Invalid pagination');
  const terms=[...new Set(query.toLocaleLowerCase().split(/\s+/u).filter(Boolean))];const catalog=await this.catalog();const current=await this.inventory();const hits=[];const excluded=[];
  for(const e of catalog.entries){const s=current.find(s=>s.registered_sha256===e.source_hash||s.sha256===e.source_hash);if(!s||s.integrity!=='ok'){excluded.push(e.source_path);continue;}if(reference&&s.id!==reference&&s.path!==reference)continue;
   const m=await this.manifest(e);
   for(const u of m.units){const data=await fs.readFile(await safePath(this.root,`.wiki-server/fulltext/${e.source_hash}/${e.generation}/${u.page}.json`),'utf8');if(sha256(data)!==u.sha256)throw Error('Fulltext cache integrity mismatch');const p=JSON.parse(data);const lower=p.text.toLocaleLowerCase();if(!terms.every(t=>lower.includes(t)))continue;
    const i=Math.min(...terms.map(t=>lower.indexOf(t)));hits.push({source_id:s.id,path:s.path,sha256:e.source_hash,page:u.page,locator:{kind:'page',page:u.page},snippet:p.text.slice(Math.max(0,i-100),i+600),needs_visual:u.needs_visual,truncated:u.truncated});
   }
  }return {query,entries:hits.slice(offset,offset+limit),total:hits.length,next_offset:offset+limit<hits.length?offset+limit:null,excluded_sources:excluded,content_is_untrusted:true,warning:'Literal text-layer search only. Read the complete cited page and inspect diagrams before adopting conclusions.'};
 }
 async outline({reference,offset=0,limit=100}){
  if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>200)throw Error('Invalid pagination');const sources=await this.inventory();const s=sources.find(s=>s.id===reference||s.path===reference);if(!s||s.integrity!=='ok')throw Error('Source missing or changed');
  const item=(await this.catalog()).entries.find(e=>e.source_hash===s.sha256);if(!item)throw Error('Source has not been indexed');const m=await this.manifest(item);
  return {source_id:s.id,path:s.path,sha256:s.sha256,page_count:m.page_count,entries:m.outline.slice(offset,offset+limit),total:m.outline.length,next_offset:offset+limit<m.outline.length?offset+limit:null,warning:'Bookmarks are source-supplied navigation, not verified chapter coverage; some drawings have none.'};
 }
}
