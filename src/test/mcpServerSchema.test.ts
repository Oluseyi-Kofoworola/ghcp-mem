import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TOOLS } from '../mcpServer';

/**
 * Schema-shape regression tests for our two surface areas that expose tools
 * to external consumers:
 *   1. The MCP `TOOLS` catalog served over stdio for non-Copilot agents.
 *   2. The VS Code `languageModelTools` contribution in package.json served
 *      to GitHub Copilot Chat.
 *
 * Both lists must keep the same shape (name + description + inputSchema with
 * type=object). A regression here silently breaks every external agent.
 */

interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

function readPackageJson(): {
  contributes?: {
    languageModelTools?: Array<{
      name: string;
      modelDescription?: string;
      inputSchema?: { type?: string; properties?: Record<string, unknown>; required?: string[] };
    }>;
  };
} {
  // Resolve relative to repo root: out-test/src/test/* → ../../..
  const candidates = [
    path.resolve(__dirname, '..', '..', '..', 'package.json'),
    path.resolve(__dirname, '..', '..', 'package.json'),
    path.resolve(process.cwd(), 'package.json'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      return JSON.parse(fs.readFileSync(c, 'utf8'));
    }
  }
  throw new Error('package.json not found via any candidate path');
}

test('MCP TOOLS catalog — every entry has a valid JSON-Schema input', () => {
  assert.ok(Array.isArray(TOOLS), 'TOOLS must be an array');
  assert.ok(TOOLS.length >= 1, 'TOOLS must expose at least one tool');
  const seen = new Set<string>();
  for (const t of TOOLS as ToolDescriptor[]) {
    assert.ok(typeof t.name === 'string' && t.name.length > 0, `tool name missing`);
    assert.ok(!seen.has(t.name), `duplicate tool name: ${t.name}`);
    seen.add(t.name);
    assert.ok(
      typeof t.description === 'string' && t.description.length >= 10,
      `tool ${t.name} description too short`,
    );
    assert.ok(t.inputSchema, `tool ${t.name} missing inputSchema`);
    assert.equal(t.inputSchema.type, 'object', `tool ${t.name} inputSchema.type must be 'object'`);
    if (t.inputSchema.required) {
      assert.ok(Array.isArray(t.inputSchema.required), `tool ${t.name} required must be array`);
      const props = Object.keys(t.inputSchema.properties ?? {});
      for (const r of t.inputSchema.required) {
        assert.ok(props.includes(r), `tool ${t.name}: required[${r}] not in properties`);
      }
    }
  }
});

test('languageModelTools contribution — every entry has a valid JSON-Schema input', () => {
  const pkg = readPackageJson();
  const tools = pkg.contributes?.languageModelTools ?? [];
  assert.ok(tools.length >= 1, 'package.json must contribute at least one languageModelTool');
  const seen = new Set<string>();
  for (const t of tools) {
    assert.ok(typeof t.name === 'string' && t.name.length > 0, `tool name missing`);
    assert.ok(!seen.has(t.name), `duplicate languageModelTool name: ${t.name}`);
    seen.add(t.name);
    assert.ok(
      t.modelDescription && t.modelDescription.length >= 20,
      `tool ${t.name} modelDescription too short`,
    );
    assert.ok(t.inputSchema, `tool ${t.name} missing inputSchema`);
    assert.equal(t.inputSchema.type, 'object', `tool ${t.name} inputSchema.type must be 'object'`);
    if (t.inputSchema.required) {
      assert.ok(Array.isArray(t.inputSchema.required), `tool ${t.name} required must be array`);
      const props = Object.keys(t.inputSchema.properties ?? {});
      for (const r of t.inputSchema.required) {
        assert.ok(props.includes(r), `tool ${t.name}: required "${r}" not in properties`);
      }
    }
  }
});

test('chat participant slash-commands — every command has name + description', () => {
  const pkg = readPackageJson() as any;
  const participants = pkg.contributes?.chatParticipants ?? [];
  assert.ok(participants.length >= 1);
  for (const p of participants) {
    const cmds: Array<{ name: string; description: string }> = p.commands ?? [];
    for (const c of cmds) {
      assert.ok(
        typeof c.name === 'string' && /^[a-z][a-z0-9-]*$/.test(c.name),
        `bad slash command name: ${c.name}`,
      );
      assert.ok(
        typeof c.description === 'string' && c.description.length >= 5,
        `slash command ${c.name} description too short`,
      );
    }
  }
});
