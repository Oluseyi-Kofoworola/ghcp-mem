#!/usr/bin/env node
/**
 * Baton CI Seeder — headless CLI for pre-populating memory from CI/CD pipelines.
 *
 * Reads a JSON memory payload from stdin, applies redaction, and merges into
 * ~/.baton-mem/sessions.json so that the next time a developer opens VS Code,
 * their AI assistant already has context from the live production environment,
 * infrastructure changes, or staging test results.
 *
 * Usage:
 *   echo '{"sessions": [...], "observations": [...]}' | node out/ciSeeder.js
 *
 * Example GitHub Actions workflow:
 *   - name: Seed Baton with prod context
 *     run: |
 *       gh release view prod --json body -q .body | \
 *       jq '{sessions: [.prod_summary], observations: .prod_alerts}' | \
 *       node ciSeeder.js
 *
 * Returns:
 *   - Exit code 0: success
 *   - Exit code 1: stdin parse error, redaction failure, or write error
 */

import { promises as fs } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { redact } from './redactor';
import type { ContextDatabase, CompressedSession, ObservationType } from './types';

interface CISeedPayload {
  /** Sessions to merge into the local store. */
  sessions: Partial<CompressedSession>[];
  /** Free-form observations (e.g., prod alerts, infrastructure notes) to be tagged for later retrieval. */
  observations?: string[];
  /** Label for this seed (e.g., "prod-alert", "staging-test", "infra-change"). */
  seedLabel?: string;
}

async function main(): Promise<void> {
  try {
    // Read stdin
    const lines: string[] = [];
    process.stdin.setEncoding('utf-8');

    for await (const chunk of process.stdin) {
      lines.push(chunk);
    }

    const jsonStr = lines.join('');
    if (!jsonStr.trim()) {
      console.error('[Baton-CI] No input from stdin.');
      process.exit(1);
    }

    let payload: CISeedPayload;
    try {
      payload = JSON.parse(jsonStr);
    } catch (err) {
      console.error(`[Baton-CI] Failed to parse stdin JSON: ${err}`);
      process.exit(1);
    }

    if (!payload.sessions || !Array.isArray(payload.sessions)) {
      console.error('[Baton-CI] Payload must have a "sessions" array.');
      process.exit(1);
    }

    // Load existing store
    const storeDir = join(homedir(), '.baton-mem');
    const storePath = join(storeDir, 'sessions.json');

    let db: ContextDatabase;
    try {
      const content = await fs.readFile(storePath, 'utf-8');
      db = JSON.parse(content);
    } catch {
      // Initialize fresh store if file doesn't exist or is unreadable
      db = { version: 1, sessions: [], lastUpdated: Date.now(), observations: [] };
    }

    if (!db.sessions) db.sessions = [];
    if (!db.observations) db.observations = [];
    if (!db.version) db.version = 1;
    if (!db.lastUpdated) db.lastUpdated = Date.now();

    // Process and merge sessions
    const seedLabel = payload.seedLabel ?? 'ci-seed';
    let mergedCount = 0;

    for (const sess of payload.sessions) {
      // Validate and sanitize
      if (!sess.id) sess.id = randomUUID();
      if (!sess.workspaceId) sess.workspaceId = 'ci-' + randomUUID().slice(0, 8);
      if (!sess.workspaceName) sess.workspaceName = 'CI/CD Pipeline';
      if (!sess.startTime) sess.startTime = Date.now();
      if (!sess.endTime) sess.endTime = Date.now();
      if (!sess.summary) sess.summary = seedLabel;
      if (!sess.observationType) sess.observationType = 'deployment' as ObservationType;
      if (!sess.keyFiles) sess.keyFiles = [];
      if (!sess.keyTopics) sess.keyTopics = [];
      if (!sess.decisions) sess.decisions = [];
      if (!sess.problemsSolved) sess.problemsSolved = [];
      if (!sess.userTags) sess.userTags = [];
      if (!sess.redactionCount) sess.redactionCount = 0;

      // Redact summary and topics
      const redactOpts = { redactSecrets: true, honorPrivateTags: true };
      const sanitizedSummary = redact(sess.summary ?? '', redactOpts);
      sess.summary = sanitizedSummary.text;
      sess.redactionCount = (sess.redactionCount ?? 0) + sanitizedSummary.redactionCount;

      sess.keyTopics = sess.keyTopics!.map((t) => redact(t, redactOpts).text);
      sess.keyFiles = sess.keyFiles!.map((f) => redact(f, redactOpts).text);
      sess.decisions = sess.decisions!.map((d) => redact(d, redactOpts).text);
      sess.problemsSolved = sess.problemsSolved!.map((p) => redact(p, redactOpts).text);

      // Tag with seed label for easy filtering
      if (!sess.userTags!.includes(seedLabel)) {
        sess.userTags!.push(seedLabel);
      }

      // Deduplicate by content hash
      const hash = sess.contentHash ?? generateContentHash(sess as CompressedSession);
      const isDuplicate = db.sessions.some((s) => s.contentHash === hash || s.id === sess.id);

      if (!isDuplicate) {
        db.sessions.push(sess as CompressedSession);
        mergedCount++;
      }
    }

    // Merge observations (free-form text to be indexed)
    if (payload.observations && Array.isArray(payload.observations)) {
      for (const obs of payload.observations) {
        const redacted = redact(obs, { redactSecrets: true, honorPrivateTags: true });
        db.observations!.push({
          id: randomUUID(),
          text: redacted.text,
          seedLabel,
          capturedAt: new Date().toISOString(),
          redactionCount: redacted.redactionCount,
        });
      }
    }

    // Write back to disk
    try {
      await fs.mkdir(storeDir, { recursive: true });
      await fs.chmod(storeDir, 0o700);
    } catch {
      // ignore
    }

    const tmpPath = `${storePath}.${process.pid}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(db, null, 2), { encoding: 'utf-8', mode: 0o600 });
    await fs.rename(tmpPath, storePath);

    try {
      await fs.chmod(storePath, 0o600);
    } catch {
      // ignore
    }

    console.log(`[Baton-CI] Seeded ${mergedCount} session(s) into ~/.baton-mem/sessions.json`);
    process.exit(0);
  } catch (err) {
    console.error(`[Baton-CI] Fatal error: ${err}`);
    process.exit(1);
  }
}

/**
 * Generate a simple content hash from session fields.
 * Matches the logic in types.ts for consistency.
 */
function generateContentHash(session: CompressedSession): string {
  const { createHash } = require('crypto') as typeof import('crypto');
  const content = [
    session.summary,
    session.keyFiles?.join('|') ?? '',
    session.decisions?.join('|') ?? '',
    session.keyTopics?.join('|') ?? '',
  ].join('\n');
  return createHash('sha256').update(content).digest('hex');
}

main().catch((err) => {
  console.error(`[Baton-CI] Uncaught error: ${err}`);
  process.exit(1);
});
