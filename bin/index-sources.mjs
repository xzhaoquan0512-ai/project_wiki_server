#!/usr/bin/env node
import path from 'node:path';import {FulltextStore} from '../src/lib/fulltext-store.mjs';
const root=process.argv[2];if(!root||!path.isAbsolute(root))throw Error('Usage: index-sources.mjs /absolute/vault [source reference]');
console.log(JSON.stringify(await new FulltextStore(root).index({reference:process.argv[3]})));
