import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryPack, renderPackAsSkill, slugifySkillName } from '../packs';
import { Lesson, makePinnedLesson } from '../lessons';

function emptyPack(over: Partial<MemoryPack> = {}): MemoryPack {
  return {
    schemaVersion: 1,
    name: over.name ?? 'My Project',
    createdAt: over.createdAt ?? Date.UTC(2025, 0, 2),
    description: over.description,
    sessions: over.sessions ?? [],
  };
}

test('slugifySkillName — lowercases, hyphenates, trims', () => {
  assert.equal(slugifySkillName('My Project!! v2'), 'my-project-v2');
  assert.equal(slugifySkillName('   '), 'memory-pack');
  assert.match(slugifySkillName('Auth & Billing'), /^[a-z0-9-]+$/);
});

test('renderPackAsSkill — emits valid frontmatter with name + description', () => {
  const md = renderPackAsSkill(emptyPack({ name: 'Auth Service' }));
  const fm = md.split('---')[1];
  assert.match(fm, /name: auth-service/);
  assert.match(fm, /description: '.+'/);
  assert.match(md, /^---\n/);
});

test('renderPackAsSkill — escapes single quotes in description', () => {
  const md = renderPackAsSkill(emptyPack({ description: "It's a service" }));
  assert.match(md, /description: '.*It''s a service.*'/);
});

test('renderPackAsSkill — lessons become Facts and How-to sections', () => {
  const lessons: Lesson[] = [
    makePinnedLesson('The repo uses bcrypt cost 12', 'semantic'),
    makePinnedLesson('To release: bump then push the tag', 'procedural'),
  ];
  const md = renderPackAsSkill(emptyPack(), { lessons });
  assert.match(md, /## Facts/);
  assert.match(md, /bcrypt cost 12/);
  assert.match(md, /## How-to/);
  assert.match(md, /push the tag/);
});

test('renderPackAsSkill — renders session history with decisions', () => {
  const pack = emptyPack({
    sessions: [
      {
        id: 's1',
        workspaceId: 'ws',
        workspaceName: 'ws',
        startTime: Date.UTC(2025, 0, 5),
        endTime: Date.UTC(2025, 0, 5),
        summary: 'Added login flow',
        observationType: 'feature',
        keyFiles: [],
        keyTopics: [],
        decisions: ['use sessions not JWT'],
        problemsSolved: [],
        rawEventCount: 1,
        userTags: [],
        redactionCount: 0,
      },
    ],
  });
  const md = renderPackAsSkill(pack);
  assert.match(md, /## Session history/);
  assert.match(md, /2025-01-05 · feature/);
  assert.match(md, /Added login flow/);
  assert.match(md, /use sessions not JWT/);
});

test('renderPackAsSkill — caps sessions and notes omissions', () => {
  const sessions = Array.from({ length: 5 }, (_, i) => ({
    id: `s${i}`,
    workspaceId: 'ws',
    workspaceName: 'ws',
    startTime: Date.UTC(2025, 0, 1),
    endTime: Date.UTC(2025, 0, 1),
    summary: `session ${i}`,
    observationType: 'feature' as const,
    keyFiles: [],
    keyTopics: [],
    decisions: [],
    problemsSolved: [],
    rawEventCount: 1,
    userTags: [],
    redactionCount: 0,
  }));
  const md = renderPackAsSkill(emptyPack({ sessions }), { maxSessions: 2 });
  assert.match(md, /\+3 more session/);
});

test('renderPackAsSkill — ends with a single trailing newline', () => {
  const md = renderPackAsSkill(emptyPack());
  assert.ok(md.endsWith('\n'));
  assert.ok(!md.endsWith('\n\n'));
});
