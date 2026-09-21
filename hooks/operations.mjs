// Host adapters and evidence fingerprints. No model-generated boolean is a receipt.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, extname, join } from 'node:path';
import { createHash } from 'node:crypto';

export const hash = (value) => createHash('sha256').update(value).digest('hex');
const SOURCE = new Set(['.py','.js','.mjs','.cjs','.ts','.tsx','.jsx','.rs','.go','.sh','.ps1','.toml','.yaml','.yml']);
const SKIP = new Set(['.git','node_modules','__pycache__','.venv','.venv_torch_cuda','venv','.pytest_cache','artifacts','data','chart_data','report','.jev-harness']);

export function operation(input) {
  const name=String(input.tool_name || '').split(/[.:/]/).at(-1);
  const raw=input.tool_input ?? {};
  const obj=typeof raw==='object' && raw!==null ? raw : {};
  const text=typeof raw==='string' ? raw : String(obj.patch ?? obj.command ?? obj.cmd ?? obj.code ?? obj.input ?? '');
  const isPatch=/apply_patch$/.test(name) || text.startsWith('*** Begin Patch');
  const paths=[];
  if (isPatch) {
    for (const m of text.matchAll(/^\*\*\* (?:Add|Update|Delete|Move to):? File: (.+)$/gm)) paths.push(m[1].trim());
    for (const m of text.matchAll(/^\*\*\* Move to: (.+)$/gm)) paths.push(m[1].trim());
  }
  if (obj.file_path || obj.path || obj.notebook_path) paths.push(String(obj.file_path || obj.path || obj.notebook_path));
  const editing=isPatch || /^(Write|Edit|MultiEdit|NotebookEdit)$/i.test(name);
  if (editing && !paths.length) throw new Error('Unparsed mutation: no target paths');
  const command=/^(Bash|shell|exec_command|exec|js|write_stdin)$/i.test(name);
  const details=editing ? JSON.stringify(raw) : text || JSON.stringify(raw);
  if (details.length>100000) throw new Error('Operation too large to review completely; split it');
  return {name,kind:editing?'modify':command?'command':'other',paths:[...new Set(paths)],details,
          id:String(input.tool_use_id || input.call_id || hash(name+'\n'+details)),cwd:resolve(input.cwd || process.cwd())};
}

export function footprint(cwd) {
  const entries=[];let visited=0;
  function walk(dir) {
    for (const e of readdirSync(dir,{withFileTypes:true})) {
      if (++visited>80000) throw new Error('Source tree exceeds audit limit');
      if (e.isDirectory()) { if (!SKIP.has(e.name) && !e.name.startsWith('.venv')) walk(join(dir,e.name)); }
      else if (e.isFile() && (SOURCE.has(extname(e.name)) || /^(package(-lock)?\.json|.*config\.json|requirements.*\.txt)$/.test(e.name))) {
        const p=join(dir,e.name);if (statSync(p).size>2000000) throw new Error('Oversized source: '+p);
        entries.push([p.slice(cwd.length+1).replaceAll('\\','/'),hash(readFileSync(p))]);
      }
    }
  }
  walk(cwd);entries.sort((a,b)=>a[0].localeCompare(b[0]));
  return {hash:hash(JSON.stringify(entries)),files:entries.length};
}

export function sources(op, written=[]) {
  const paths=new Set([...op.paths,...written.map(x=>x.path || resolve(op.cwd,x.file))]);
  for (const m of op.details.matchAll(/(?:^|[\s"'])((?:[A-Za-z]:[\\/]|\.?[\\/])?[^\s"'<>|]+\.(?:py|mjs|cjs|js|ps1|sh))(?=$|[\s"'])/g)) paths.add(resolve(op.cwd,m[1]));
  const mod=op.details.match(/(?:^|\s)-m\s+([a-zA-Z_][\w.]*)/);
  if (mod) paths.add(resolve(op.cwd,mod[1].replaceAll('.','/')+'.py'));
  const result=[];let total=0;
  for (const raw of paths) {
    const p=resolve(op.cwd,raw);
    if (!existsSync(p)) continue;
    if (/\.(env|pem|key)$|(?:credentials|secrets|auth\.json)/i.test(p)) throw new Error('Sensitive file is not a source-review input');
    if (!SOURCE.has(extname(p)) && extname(p)!=='.json' && extname(p)!=='.md') continue;
    const content=readFileSync(p,'utf8');total+=content.length;
    if (total>140000) throw new Error('Source review too large; narrow implementation scope');
    result.push({path:p,sha256:hash(content),content});
  }
  return result;
}

export function commandResult(response) {
  let r=response;
  if (typeof r==='string') { try { r=JSON.parse(r); } catch { r={output:r}; } }
  r=r || {};
  // A running exec session is not a successful verification.
  const exit=r.exit_code ?? r.exitCode ?? r.exit_status ?? null;
  return {exit_code:exit,completed:typeof exit==='number' && !r.session_id,
          output:String(r.output ?? r.stdout ?? (typeof response==='string'?response:JSON.stringify(response??{})))};
}
