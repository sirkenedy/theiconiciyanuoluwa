// A stand-in for the Claude Messages API for Career Coach tests (no key, no network, no cost).
// - structured-output requests get a Profile JSON (or the queued `profileReplies`), or for rank_jobs a fit per job
//   in the order sent (state.fits)
// - streamed requests get a short coaching answer + <suggest> block
// - other requests (the rolling summary) get a one-line summary
// Every request body is recorded so tests can check exactly what would have been sent to Anthropic.
// `node tests/fake-claude.mjs 4331` serves it; GET /__requests returns the log, POST /__reset clears it,
// POST /__invent | /__honest switches the written résumé; state.analysis overrides the analyze reply.
import { createServer } from 'node:http';

export const SAMPLE_PROFILE = {
  identity: { name: 'Sample Candidate', headline: 'Product Designer', location: 'Lagos, Nigeria' },
  summary: 'Product designer with five years in fintech.',
  experience: [{ id: 'exp-1', role: 'Product Designer', company: 'Example Fintech', dates: '2020 – Present', highlights: ['Redesigned checkout flow'] }],
  skills: [{ group: 'Design', items: ['Figma', 'User research'] }],
  education: ['B.A. Design'],
  certifications: [],
  targetRoles: ['Product Manager'],
  seniority: 'mid',
  location: 'Lagos, Nigeria',
  remotePreference: 'remote',
  yearsExperience: 5,
};

/** An honest tailored résumé for SAMPLE_PROFILE: same employer, title and dates; numbers only from the sample résumé. */
export const HONEST_WRITE = {
  tailored: {
    name: 'Sample Candidate',
    headline: 'Product Designer',
    location: 'Lagos, Nigeria',
    summary: 'Product-minded designer who owned the checkout redesign end to end: discovery, A/B testing and roadmap input. Moving into product management.',
    skills: [{ group: 'Product', items: ['Product discovery', 'A/B testing', 'Figma', 'User research'] }],
    experience: [{ id: 'exp-1', role: 'Product Designer', company: 'Example Fintech', dates: '2020 – Present', bullets: ['Led discovery and design of the checkout redesign, from research to launch.', 'Ran user research and A/B tests end to end with the growth team.'] }],
    education: ['B.A. Design'],
    certifications: [],
  },
  changes: [
    { section: 'Summary', before: 'Product designer with five years in fintech.', after: 'Product-minded designer…', why: 'leads with product ownership, matching the role’s first requirement.' },
    { section: 'Checkout bullet', before: 'Redesigned checkout flow', after: 'Led discovery and design…', why: 'shows discovery and cross-functional work.' },
  ],
  ats: { before: 54, after: 88, addedKeywords: ['discovery', 'roadmap', 'A/B testing'], stillMissing: ['SQL'] },
  critique: [],
};
/** The same résumé with three inventions the code check must flag: a number, a tool and an employer. */
export const INVENTED_WRITE = {
  ...HONEST_WRITE,
  tailored: {
    ...HONEST_WRITE.tailored,
    skills: [{ group: 'Product', items: ['Product discovery', 'SQL'] }],
    experience: [
      { ...HONEST_WRITE.tailored.experience[0], bullets: ['Grew checkout conversion 37% in one quarter.'] },
      { id: 'exp-2', role: 'Product Manager', company: 'Invented Corp', dates: '2018 – 2020', bullets: [] },
    ],
  },
};
export const LETTER_CHUNKS = ['Dear hiring team,\n\n', 'I led the checkout redesign at Example Fintech, from research to launch, ', 'and ran A/B tests end to end with the growth team.\n\n', 'I would love to bring that to your product team.\n\nSincerely,\nSample Candidate'];

export function startFakeClaude(port = 0) {
  const requests = [];
  const state = { fits: [92, 81, 76, 64, 58, 40, 35], questions: [{ id: 'q1', question: 'How many A/B tests did you run on the checkout?' }], write: HONEST_WRITE, letter: LETTER_CHUNKS, profileReplies: [], chatChunks: ['Lead with ', 'outcomes: name the ', '**checkout redesign** and what changed for users.'], suggest: '<suggest>["Find jobs for me","Tailor to this job"]</suggest>', analysis: null };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url === '/__requests') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(requests));
      if (req.url === '/__reset') {
        requests.length = 0;
        return res.writeHead(204).end();
      }
      // Switch the written résumé between honest and invented output (the no-fabrication check's browser test).
      if (req.url === '/__invent' || req.url === '/__honest') {
        state.write = req.url === '/__invent' ? INVENTED_WRITE : HONEST_WRITE;
        return res.writeHead(204).end();
      }
      const params = JSON.parse(body);
      requests.push(params);
      const usage = { input_tokens: 50, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
      const message = (text) => ({ id: 'msg_fake', type: 'message', role: 'assistant', model: params.model, content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage });

      if (params.output_config?.format?.schema?.properties?.results) {
        // rank_jobs: score the jobs it was sent, in order, from state.fits (default 92, 81, 76, 64, 58, then poor fits).
        const sent = params.messages.at(-1).content;
        const list = JSON.parse(sent.slice(sent.lastIndexOf('<jobs>') + 6, sent.lastIndexOf('</jobs>')));
        const results = list.map((j, i) => ({ jobId: j.jobId, fit: state.fits[i] ?? 30, why: [`Matches your ${j.title} focus`, 'Relevant recent experience'], gaps: i % 2 ? [] : ['Asks for SQL: add it if you have used it'] }));
        return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(message(JSON.stringify({ results }))));
      }
      const props = params.output_config?.format?.schema?.properties ?? {};
      if (props.match) {
        const improve = params.messages[0].content.includes('task = "improve_analyze"');
        const analysis = state.analysis ?? { role: improve ? null : 'Product Manager, Payments', company: improve ? null : 'Sample Pay', match: [{ kind: 'strong', text: 'Strong: checkout design, experimentation, fintech' }, { kind: 'added', text: 'Added keywords: discovery, roadmap, A/B testing' }, { kind: 'missing', text: 'Missing: SQL. Not added because it isn’t in your résumé.' }], questions: state.questions };
        if (params.stream) return streamText(res, params, [JSON.stringify(analysis)]);
        return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(message(JSON.stringify(analysis))));
      }
      if (props.tailored) {
        const improve = params.messages[0].content.includes('task = "improve_write"');
        const out = improve ? { ...state.write, critique: ['clarity', 'impact', 'keywords', 'structure', 'length'].map((area) => ({ area, note: `Sample note about ${area}.` })) } : state.write;
        // Structured outputs can stream too: the endpoint streams internally for long outputs.
        if (params.stream) return streamText(res, params, [JSON.stringify(out)]);
        return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(message(JSON.stringify(out))));
      }
      if (params.output_config?.format) {
        const next = state.profileReplies.length ? state.profileReplies.shift() : JSON.stringify(SAMPLE_PROFILE);
        return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(message(next)));
      }
      if (!params.stream) return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(message('The visitor is a product designer moving into product management.')));
      if (params.messages[0].content.includes('task = "cover_letter"')) return streamText(res, params, state.letter);
      // Asked for a downloadable file: offer the tools by their exact labels, as the prompt requires.
      if (/download|pdf|docx/i.test(params.messages.at(-1).content)) return streamText(res, params, ['The button below builds it with Download DOCX/PDF.', '<suggest>["Make my résumé stronger","Tailor my résumé to a job","Write a cover letter"]</suggest>']);
      // A hostile answer, to prove model output is sanitised (DOMPurify) before it reaches the page.
      if (params.messages.at(-1).content.includes('XSS-TEST')) return streamText(res, params, ['Safe **bold**. <img src=x onerror="window.__xss=1"> ', '[click](javascript:window.__xss=2) and [a real link](https://example.org/guide)\n', '<script>window.__xss=3</script>']);

      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      send('message_start', { type: 'message_start', message: { ...message(''), content: [], stop_reason: null } });
      send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      for (const text of [...state.chatChunks, state.suggest]) send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
      send('content_block_stop', { type: 'content_block_stop', index: 0 });
      send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } });
      send('message_stop', { type: 'message_stop' });
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(port, () => resolve({ server, requests, state, url: `http://127.0.0.1:${server.address().port}` })));
}

function streamText(res, params, chunks) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send('message_start', { type: 'message_start', message: { id: 'msg_fake', type: 'message', role: 'assistant', model: params.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 50, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
  send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  for (const text of chunks) send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
  send('content_block_stop', { type: 'content_block_stop', index: 0 });
  send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } });
  send('message_stop', { type: 'message_stop' });
  res.end();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { url } = await startFakeClaude(Number(process.argv[2]) || 4331);
  console.log(`fake claude on ${url}`);
}
