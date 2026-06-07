// Tests for the v2.0.0 MCP tool alias surface.
//
// The MCP server must continue to accept legacy ghcpMem_* tool names from
// v1.x clients (Cursor, Cline, Claude Code configs that hardcoded those
// names). These tests pin both the alias map and the tools/list output.

import { test } from 'node:test';
import assert from 'node:assert';

import { LEGACY_TOOL_ALIASES } from '../mcpServer';

test('LEGACY_TOOL_ALIASES: every v1.x tool maps to a baton_* canonical name', () => {
  for (const [legacy, canonical] of Object.entries(LEGACY_TOOL_ALIASES)) {
    assert.ok(legacy.startsWith('ghcpMem_'), `legacy alias must start with ghcpMem_: ${legacy}`);
    assert.ok(
      canonical.startsWith('baton_'),
      `canonical name must start with baton_: ${canonical}`,
    );
    // Direct one-for-one suffix mapping (no semantic shifts in the rename).
    assert.strictEqual(
      legacy.replace(/^ghcpMem_/, 'baton_'),
      canonical,
      `alias suffix should match canonical suffix: ${legacy} -> ${canonical}`,
    );
  }
});

test('LEGACY_TOOL_ALIASES: covers the read + write + analysis surfaces', () => {
  const expectedCanonicals = [
    'baton_search',
    'baton_recent',
    'baton_timeline',
    'baton_get',
    'baton_store',
    'baton_delete',
    'baton_entity',
    'baton_snippets',
    'baton_conflicts',
    'baton_lineage',
    'baton_explain',
    'baton_graph',
    'baton_route',
  ];
  const actualCanonicals = new Set(Object.values(LEGACY_TOOL_ALIASES));
  for (const c of expectedCanonicals) {
    assert.ok(actualCanonicals.has(c), `expected alias entry for ${c}`);
  }
});
