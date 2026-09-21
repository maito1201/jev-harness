import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("Codex正式manifestと既定のhooks/hooks.jsonに4工程がある", () => {
  const manifest = JSON.parse(readFileSync(new URL("../.codex-plugin/plugin.json", import.meta.url), "utf8"));
  assert.equal(manifest.hooks, undefined);
  const definition=JSON.parse(readFileSync(new URL('../hooks/hooks.json',import.meta.url),'utf8'));
  for(const event of ['UserPromptSubmit','PreToolUse','PostToolUse','Stop'])assert.ok(definition.hooks[event]?.length);
});
