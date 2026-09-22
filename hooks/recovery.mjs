// Recovery must not depend on the service that is failing. This is deliberately
// a tiny grammar, not a general shell safety classifier or an eval of tool code.
export const MAX_STALLED_STOPS = 3;
export function diagnosticRead(input) {
  const name=String(input.tool_name || '');
  const raw=input.tool_input;
  if (['Read','functions.Read'].includes(name)) return true;
  if (['exec','functions.exec'].includes(name)) {
    const code=typeof raw==='string'?raw:raw?.code;
    const match=typeof code==='string' && code.match(/^\s*(?:text\(\s*)?await tools\.exec_command\((\{[\s\S]*\})\)\s*\)?\s*;?\s*$/);
    if(!match)return false;
    try{return diagnosticRead({tool_name:'exec_command',tool_input:JSON.parse(match[1])});}catch{return false;}
  }
  if(!['exec_command','functions.exec_command'].includes(name) || !raw || typeof raw!=='object')return false;
  if(raw.shell && !/(?:^|[\\/])(?:pwsh|powershell)(?:\.exe)?$/i.test(raw.shell))return false;
  const cmd=raw.cmd;
  // No interpolation, pipelines, redirects, scripts, providers, wildcards or
  // extra switches. A caller can use native Read for more complex paths.
  return typeof cmd==='string' && /^(?:Microsoft\.PowerShell\.Management\\)?Get-Content\s+-LiteralPath\s+'[A-Za-z0-9 _./\\:\-]+'(?:\s+-(?:TotalCount|Tail)\s+[1-9][0-9]{0,3})?\s*$/i.test(cmd)
    && !/\b(?:env|function|alias|variable|registry|cert):/i.test(cmd);
}
