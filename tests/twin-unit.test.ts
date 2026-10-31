// Fast, offline checks for the twin's privacy and stream helpers. `npm run test:unit`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { expand, leakedNameParts, tokenise, type Placeholder } from '../src/lib/twin-privacy.ts';
import { MetaSplitter, normaliseQuestion, parseMeta, stripHtml } from '../src/lib/twin-stream.ts';
import { SYSTEM_PROMPT, CITE_IDS } from '../src/content/twin-prompt.ts';

const resume = JSON.parse(readFileSync('src/content/resume.json', 'utf8'));
const client = JSON.parse(readFileSync('src/content/twin-client.json', 'utf8'));
const pairs = client.pairs as [string, Placeholder][];

test('system prompt and tokenised résumé contain no part of the owner name', () => {
  assert.deepEqual(leakedNameParts(SYSTEM_PROMPT, resume.identity), []);
  assert.deepEqual(leakedNameParts(readFileSync('src/content/resume.twin.json', 'utf8'), resume.identity), []);
  assert.ok(SYSTEM_PROMPT.includes('{{NAME}}'));
  assert.ok(!SYSTEM_PROMPT.includes('{{RESUME_JSON}}'));
});

test('visitor input is tokenised before sending; display expands it back', () => {
  const first = resume.identity.name.split(' ')[0];
  const sent = tokenise(`Is ${first.toUpperCase()} open to work? Mail ${resume.identity.email}`, pairs);
  assert.equal(leakedNameParts(sent, resume.identity).length, 0);
  assert.match(sent, /\{\{NAME\}\}.*\{\{EMAIL\}\}/);
  assert.equal(expand('Hi, I am {{NAME}}.', client.values), `Hi, I am ${resume.identity.name}.`);
});

test('a placeholder split across stream chunks is held back until complete', () => {
  assert.equal(expand('Email {{EM', client.values, false), 'Email ');
  assert.equal(expand('Email {', client.values, false), 'Email ');
  assert.equal(expand('Email {{EMAIL}}', client.values, false), `Email ${resume.identity.email}`);
});

test('meta block never reaches the visible stream, even when split', () => {
  const s = new MetaSplitter();
  const out = ['I led the MCP launch.', '\n<me', 'ta>{"cite":["exp-1","exp-99"],"followups":["What', ' next?"],"action":"rm -rf"}</meta>'].map((c) => s.push(c)).join('');
  const { tail, meta } = s.end();
  assert.equal(out + tail, 'I led the MCP launch.\n');
  const parsed = parseMeta(meta, CITE_IDS, s.visible);
  assert.deepEqual(parsed.cite, ['exp-1']);
  assert.equal(parsed.action, null);
  assert.deepEqual(parsed.followups, ['What next?']);
});

test('text ending in "<" that is not meta is released at the end', () => {
  const s = new MetaSplitter();
  assert.equal(s.push('a < b and c <'), 'a < b and c ');
  assert.equal(s.end().tail, '<');
});

test('broken meta JSON degrades to empty extras; unknown answers are flagged', () => {
  const m = parseMeta('<meta>{not json</meta>', CITE_IDS, "That's not something I can answer from my résumé.");
  assert.deepEqual(m, { cite: [], followups: [], action: null, unknown: true });
});

test('question normalisation and HTML stripping', () => {
  assert.equal(normaliseQuestion('  What did you DO at Spidra?!  '), 'what did you do at spidra');
  assert.equal(stripHtml('<img src=x onerror=alert(1)>hello <b>there</b>'), 'hello there');
});
