// Read-only RPC. Connect to the existing app-server; never start a task or model.
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
const cli=process.argv[2];if(!cli)throw new Error('usage: node inspect-host.mjs CODEX_JS [--standalone]');
const standalone=process.argv.includes('--standalone');
const child=spawn(process.execPath,[cli,'app-server',...(standalone?['--stdio']:['proxy'])],{windowsHide:true});
let id=0;const pending=new Map();let errors='';
child.stderr.on('data',d=>errors+=d);
const reader=createInterface({input:child.stdout});
reader.on('line',line=>{try{const m=JSON.parse(line);if(pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);}}catch{}});
const send=(method,params)=>new Promise(resolve=>{const n=++id;pending.set(n,resolve);child.stdin.write(JSON.stringify({id:n,method,params})+'\n');});
const timer=setTimeout(()=>{console.error('RPC timeout: '+errors.slice(-1200));child.kill();process.exitCode=1;},20000);
try{
 const init=await send('initialize',{clientInfo:{name:'jev-audit',version:'1.0.0'},capabilities:{experimentalApi:true,requestAttestation:false}});
 if(init.error)throw new Error(JSON.stringify(init.error));
 child.stdin.write(JSON.stringify({method:'initialized'})+'\n');
 const r=await send('hooks/list',{cwds:['G:/project/kabu']});
 console.log(JSON.stringify({connection:standalone?'standalone_cli_configuration':'existing_app_server',result:r.result?.data?.map(x=>({...x,hooks:x.hooks.filter(h=>h.pluginId?.includes('jev') || h.command?.includes('jev'))})),error:r.error},null,2));
}finally{clearTimeout(timer);child.kill();reader.close();}
