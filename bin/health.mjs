import {readFileSync} from 'node:fs';
import {auditHealth} from '../hooks/observations.mjs';
const [path,session]=process.argv.slice(2);
if(!path || !session)throw new Error('usage: node bin/health.mjs LOG_JSONL SESSION_ID');
const events=readFileSync(path,'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line));
console.log(JSON.stringify(auditHealth(events,session),null,2));
