import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("Codex互換マニフェストがライフサイクルフックを明示する", () => {
  const manifest = JSON.parse(readFileSync(new URL("../.codex-plugin/plugin.json", import.meta.url), "utf8"));
  assert.equal(manifest.hooks, "./hooks/hooks.json");
});
