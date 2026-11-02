// Turn-taking and delivery for spoken mock-interview answers (src/lib/career/voice.ts). Pure: no audio. `npm run test:unit`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WAIT, checkIn, delivery, deliveryLine, needsNudge, turnDone } from '../src/lib/career/voice.ts';

test('a finished-sounding answer ends after a short pause; a long one sooner than a short one', () => {
  const long = 'I redesigned the checkout flow with the growth team, and completion went up by twelve percent in a month.';
  assert.equal(turnDone(long, WAIT.sentence - 100), false);
  assert.equal(turnDone(long, WAIT.sentence), true);
  assert.equal(turnDone('It went well.', WAIT.sentence), false, 'a very short answer gets more time');
  assert.equal(turnDone('It went well.', WAIT.shortSentence), true);
});

test('trailing off ("and…", "um", a comma) waits much longer: they are still thinking', () => {
  for (const t of ['I led the redesign and', 'So the first thing, um', 'We had three options,', 'The reason was because']) {
    assert.equal(turnDone(t, 5000), false, t);
    assert.equal(turnDone(t, WAIT.trailing), true, t);
  }
});

test('"that\'s my answer" and spoken commands are answered at once; nothing is decided while speech is still being read', () => {
  for (const t of ["We shipped it in six weeks. That's my answer.", 'Yeah, that’s it.'.replace('’', "'"), "So that's how we did it.", 'Can you repeat that?', 'Skip this one.', "Let's stop here."]) {
    assert.equal(turnDone(t, WAIT.finished), true, t);
  }
  assert.equal(turnDone("That's my answer.", 10_000, true), false, 'pending transcription');
  assert.equal(turnDone('', 20_000), false, 'silence alone never ends a turn');
});

test('a gentle nudge only after 10 s with nothing said', () => {
  assert.equal(needsNudge('', 9_900), false);
  assert.equal(needsNudge('', 10_000), true);
  assert.equal(needsNudge('I think', 30_000), false);
});

test('delivery: pace, fillers (a minimum: recognition tidies speech), long pauses', () => {
  const d = delivery(
    [
      { text: 'Um, so basically I led the redesign, like, end to end.', ms: 6000 },
      { text: 'You know, it lifted completion by twelve percent.', ms: 5000 },
    ],
    [4000],
  );
  assert.equal(d.seconds, 15);
  assert.equal(d.words, 19);
  assert.equal(d.wpm, 76);
  assert.equal(d.fillers, 4);
  assert.deepEqual(d.fillerWords, ['um', 'like', 'you know', 'basically']);
  assert.equal(d.longPauses, 1);
  assert.equal(deliveryLine(d), '15 s · 76 words a minute · 4 filler words (um, like, you know, basically) · 1 long pause');
  assert.equal(delivery([{ text: 'You know what I mean? I know how.', ms: 3000 }], []).fillers, 0, '"you know what" is not a filler');
});

test('their own ways of finishing: "I am done", "that will be all", a closing "thank you" (not an opening one)', () => {
  for (const t of ['We shipped it in six weeks and it worked. I am done.', 'And it doubled sign-ups. That will be all.', "That's all.", 'So we cut the steps from five to two and completion went up a lot. Thank you.']) {
    assert.equal(turnDone(t, WAIT.finished), true, t);
  }
  assert.equal(turnDone('Okay, thank you.', WAIT.finished), false, 'an opening "thank you" is not an answer');
  assert.equal(turnDone('Alright, thank you for the question. At Spidera I led', 3500), false, 'thinking mid-sentence');
});

// 20 ms frames at a steady loudness (dB).
const frames = (gate: import('../src/lib/career/voice.ts').SpeechGate, db: number, ms: number) => {
  const out: string[] = [];
  for (let i = 0; i < ms / 20; i++) {
    const r = gate.frame(db + (i % 7) - 3); // a little natural wobble
    if (r) out.push(r);
  }
  return out;
};

test('speech gate: a steady fan or raised mic gain after speaking still ends the speech (it used to hang)', async () => {
  const { SpeechGate } = await import('../src/lib/career/voice.ts');
  const quietRoom = new SpeechGate();
  assert.deepEqual([...frames(quietRoom, -62, 1000), ...frames(quietRoom, -25, 2000), ...frames(quietRoom, -62, 1000)], ['start', 'end']);

  // The bug: speech, then a fan at -38 dB, well above the quiet room's floor. It must still end.
  const fan = new SpeechGate();
  assert.deepEqual([...frames(fan, -62, 1000), ...frames(fan, -25, 2000)], ['start']);
  assert.deepEqual(frames(fan, -38, 1500), ['end']);

  // Noise from the start: the floor rises to it, and speech above it still starts and ends.
  const noisy = new SpeechGate();
  assert.deepEqual([...frames(noisy, -40, 1500), ...frames(noisy, -20, 2000), ...frames(noisy, -40, 1500)], ['start', 'end']);
});

test('speech gate: short dips between words never end the speech', async () => {
  const { SpeechGate } = await import('../src/lib/career/voice.ts');
  const gate = new SpeechGate();
  const out = frames(gate, -62, 1000);
  for (let i = 0; i < 10; i++) out.push(...frames(gate, -24, 400), ...frames(gate, -45, 300)); // words and gaps
  assert.deepEqual(out, ['start']);
  assert.deepEqual(frames(gate, -62, 1000), ['end']);
});

test('noise guessed as a word is not speech; real words at any length are', async () => {
  const { isWords, decisive } = await import('../src/lib/career/voice.ts');
  assert.equal(isWords('The', 4000), false, 'a fan surge heard as one word');
  assert.equal(isWords('So.', 2600), false);
  assert.equal(isWords('[BLANK_AUDIO]', 900), false);
  assert.equal(isWords('', 1200), false);
  assert.equal(isWords('Yes.', 600), true, 'a one-word answer');
  assert.equal(isWords('I am done.', 900), true);
  assert.equal(isWords('At Spidra I led the launch of our brief builder.', 3500), true);
  assert.equal(decisive('…and adoption reached forty percent. I am done.'), true);
  assert.equal(decisive('That will be all.'), true);
  assert.equal(decisive('We shipped it in eight weeks.'), false);
});

test('stray stock phrases from near-silence are dropped; a command at the end of a short utterance still counts', async () => {
  const { isWords, decisive } = await import('../src/lib/career/voice.ts');
  assert.equal(isWords('Thank you.', 900, 14), false, '"Thank you." from a breath');
  assert.equal(isWords('Hello.', 800, 15), false);
  assert.equal(isWords('Thank you.', 900, 28), true, 'said clearly');
  assert.equal(isWords('I led the launch of our brief builder.', 2500, 9), false, 'too quiet to be speech');
  assert.equal(isWords('I led the launch of our brief builder.', 2500, 24), true);
  assert.equal(decisive('Thank you. Hello, please repeat'), true);
  assert.equal(turnDone('Thank you. Hello, please repeat', WAIT.command), true);
});

test('check-ins are not answers: "Hello? Can you hear me?", "One moment", "What was the question?" (and answers that start like them still are)', () => {
  const cases: [string, ReturnType<typeof checkIn>][] = [
    ['Hi', 'presence'], ['Hello?', 'presence'], ['Hellow', 'presence'], ['Hello? Are you there?', 'presence'], ['Can you hear me?', 'presence'],
    ['Are you still there?', 'presence'], ['Hey Ami', 'presence'], ['Is this working?', 'presence'], ['Hello, can you hear me now?', 'presence'], ['Did you hear me?', 'presence'],
    ['One moment.', 'wait'], ['Give me a second', 'wait'], ['Let me think.', 'wait'], ['Hold on', 'wait'],
    ['Sorry?', 'question'], ['What was the question?', 'question'], ["Sorry, I didn't catch that.", 'question'], ['Hello? What was the question?', 'question'],
    ['I am done.', 'done'], ["Hello? I'm done.", 'done'], ["That's it.", 'done'],
  ];
  for (const [t, kind] of cases) assert.equal(checkIn(t), kind, t);
  for (const t of ['Hi, so I led the checkout redesign at Sample Pay.', 'Sorry, I think the main thing was speed.', 'I am done with the first version and then we shipped it.', 'Yes', 'Okay.', 'Let me think about the metrics we used: completion and time to pay.'])
    assert.equal(checkIn(t), null, t);
});

test('a check-in is answered after a short pause (like a person), not after the long "short answer" wait', () => {
  assert.equal(turnDone('Hello? Are you there?', WAIT.checkIn - 100), false);
  assert.equal(turnDone('Hello? Are you there?', WAIT.checkIn), true);
  assert.ok(WAIT.checkIn < WAIT.shortSentence);
});
