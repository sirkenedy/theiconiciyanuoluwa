// A stand-in for the Claude Messages API for Career Coach tests (no key, no network, no cost).
// - structured-output requests get a Profile JSON (or the queued `profileReplies`), or for rank_jobs a fit per job
//   in the order sent (state.fits)
// - streamed requests get a short coaching answer + <suggest> block
// - other requests (the rolling summary) get a one-line summary
// Every request body is recorded so tests can check exactly what would have been sent to Anthropic.
// `node tests/fake-claude.mjs 4331` serves it; GET /__requests returns the log, POST /__reset clears it,
// POST /__invent | /__honest switches the written résumé; POST /__profile queues a profile reply; state.analysis overrides
// the analyze reply.
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
      // Queue the next profile the "model" extracts (a browser test needs a specific visitor).
      if (req.url === '/__profile') {
        state.profileReplies.push(body);
        return res.writeHead(204).end();
      }
      const params = JSON.parse(body);
      requests.push(params);
      // Like the real API: Sonnet 5.5 rejects thinking "disabled" (it takes "between_tools").
      if (/sonnet-5/.test(params.model) && params.thinking?.type === 'disabled') {
        return res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'To turn thinking off on this model, send "thinking": {"type": "between_tools"} instead of {"type": "disabled"}.' } }));
      }
      const usage = { input_tokens: 50, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
      const message = (text) => ({ id: 'msg_fake', type: 'message', role: 'assistant', model: params.model, content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage });

      if (params.output_config?.format?.schema?.properties?.results) {
        // rank_jobs: score the jobs it was sent, in order, from state.fits (default 92, 81, 76, 64, 58, then poor fits).
        const sent = params.messages.at(-1).content;
        const list = JSON.parse(sent.slice(sent.lastIndexOf('<jobs>') + 6, sent.lastIndexOf('</jobs>')));
        const results = list.map((j, i) => ({ jobId: j.jobId, fit: state.fits[i] ?? 30, why: [`Matches your ${j.title} focus`, 'Relevant recent experience'], gaps: i % 2 ? [] : ['Asks for SQL: add it if you have used it'] }));
        return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(message(JSON.stringify({ results }))));
      }
      // Prep research (Sonnet + web search): a short cited note, with the searches billed in usage.
      if (params.tools?.some((t) => t.type?.startsWith('web_search'))) {
        const cited = { type: 'text', text: 'Sample Pay builds checkout and payments tools for schools; its values page stresses customer obsession.', citations: [{ type: 'web_search_result_location', url: 'https://samplepay.test/about', title: 'About Sample Pay', cited_text: 'customer obsession', encrypted_index: 'x' }] };
        return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ...message(''), content: [cited], usage: { ...usage, server_tool_use: { web_search_requests: 2 } } }));
      }
      const props = params.output_config?.format?.schema?.properties ?? {};
      // Mock interview turn: an interviewer that follows up on vague answers ("we", no result) and respects <status>.
      if (props.action) {
        const blocks = params.messages[0].content;
        const all = Array.isArray(blocks) ? blocks.map((b) => b.text).join('\n') : blocks;
        const allowed = props.action.enum;
        const lines = (all.match(/<interview>\n([\s\S]*?)\n<\/interview>/)?.[1] ?? '').split('\n').filter((l) => /^(Ami|Candidate)/.test(l));
        const asked = lines.filter((l) => l.startsWith('Ami (ask)')).length;
        const lastAnswer = [...lines].reverse().find((l) => l.startsWith('Candidate:'))?.slice(11) ?? '';
        const lastAmi = [...lines].reverse().find((l) => l.startsWith('Ami'));
        const noBehavioural = /no behaviou?ral/i.test(all.match(/<setup>([\s\S]*?)<\/setup>/)?.[1] ?? '');
        const QUESTIONS = ['How would you improve checkout for schools?', noBehavioural ? 'How would you prioritise a payments roadmap?' : 'Tell me about a time you disagreed with engineering.', 'How do you measure a launch?', 'Why Sample Pay?', 'What would you do in your first 90 days?', 'How do you work with design?', 'Tell me about a metric you moved.', 'What questions do you have for me?'];
        const vague = lastAnswer && lastAnswer !== '(skipped)' && (lastAnswer.split(/\s+/).length < 12 || (/\bwe\b/i.test(lastAnswer) && !/\bI\b/.test(lastAnswer)));
        let turn;
        if (!lines.length) turn = { action: 'ask', say: `Hi, I'm Ami, and I'll be your interviewer today. Let's begin: ${QUESTIONS[0]}`, note: null };
        else if (/\?\s*$/.test(lastAnswer) && allowed.includes('reply')) turn = { action: 'reply', say: `Good question. Take it at whatever level you like. ${QUESTIONS[Math.max(0, asked - 1)]}` };
        else if (vague && allowed.includes('follow_up') && !lastAmi?.startsWith('Ami (follow_up)')) turn = { action: 'follow_up', say: 'What exactly was your own part, and what was the result?' };
        else if (allowed.includes('ask')) turn = { action: 'ask', say: `Thanks. ${QUESTIONS[asked] ?? 'One more:'}` };
        else turn = { action: 'end', say: 'That was the last question. Thank you, your scorecard is on its way.' };
        turn.note ??= lastAnswer === '(skipped)' ? 'Skipped.' : vague ? 'Vague: no result, unclear personal role.' : 'Specific: named the result.';
        turn.react = !lines.length ? 'smile' : vague ? 'thoughtful' : 'impressed';
        // A spoken answer comes back with recognition slips fixed (and one invented sentence, when asked to test the guard).
        turn.heard = /was spoken/.test(all) ? (/INVENT/.test(lastAnswer) ? `${lastAnswer} I also led a team of 40 engineers across three countries.` : lastAnswer.replace(/\bcheck out\b/gi, 'checkout').replace(/\bsample pay\b/gi, 'Sample Pay')) : null;
        const out = JSON.stringify({ say: turn.say, action: allowed.includes(turn.action) ? turn.action : allowed[0], react: turn.react, note: turn.note, heard: turn.heard ?? null });
        if (params.stream) return streamText(res, params, [out]);
        return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(message(out)));
      }
      // Interview scorecard: one entry per main question asked, stronger answers from the résumé.
      if (props.readiness) {
        const sent = params.messages[0].content;
        const asks = [...sent.matchAll(/^Ami \(ask\): (?:Hi, I'm Ami, and I'll be your interviewer today\. Let's begin: |Thanks\. )?(.+)$/gm)].map((m) => m[1]);
        const fb = { score: 3.5, readiness: 'almost', summary: 'Clear examples, but results were often missing until you were asked.', strengths: ['Named the checkout redesign'], fixes: ['Lead with the result'], practise: ['Answer in situation, action, result'], questions: asks.map((q) => ({ question: q, score: 3, strong: ['Relevant example'], missing: ['A measurable result'], followups: 'Gave your role when asked.', better: ['Open with the checkout redesign at Example Fintech.', 'Say what you changed and what happened.'] })) };
        const out = JSON.stringify(fb);
        if (params.stream) return streamText(res, params, [out]);
        return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(message(out)));
      }
      // Prep guide: follows <instructions> ("3-day" → Day sections; "no behavioural" → none), answers from the résumé.
      if (props.sections) {
        const sent = params.messages[0].content;
        const ask = (sent.match(/<instructions>([\s\S]*?)<\/instructions>/)?.[1] ?? '').toLowerCase();
        const q = (title) => ({ kind: 'question', title, text: null, bullets: [], why: 'They test product judgement.', answer: ['Use the checkout redesign: Redesigned the checkout flow used daily by thousands.', 'Say what you learned.'] });
        const sections = /3-day|three-day/.test(ask)
          ? [1, 2, 3].map((d) => ({ heading: `Day ${d}`, intro: null, items: [{ kind: 'step', title: `Day ${d} focus`, text: 'Practise two questions aloud.', bullets: [], why: null, answer: [] }] }))
          : [{ heading: 'Product sense', intro: null, items: [q('How would you improve checkout for schools?')] }, ...(/no behaviou?ral/.test(ask) ? [] : [{ heading: 'Behavioural', intro: null, items: [q('Tell me about a conflict with engineering.')] }])];
        const guide = { title: 'Interview prep: Product Manager, Payments', subtitle: 'Sample Pay', note: 'These are likely questions predicted from the posting and public information, not reported by past candidates.', sections, sources: [] };
        if (params.stream) return streamText(res, params, [JSON.stringify(guide)]);
        return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(message(JSON.stringify(guide))));
      }
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
      // Chat with tools: imitate Ami reading the whole message and picking a tool (or not).
      if (params.tools?.length) {
        // Forced tool (tool_choice): the model must call make_document; it still judges the job from the chat.
        if (params.tool_choice?.name === 'make_document') {
          const users = params.messages.filter((m) => m.role === 'user').map((m) => (typeof m.content === 'string' ? m.content : m.content.map((b) => b.text).join('')));
          const posting = users.some((t) => t.replace(/[\s\S]*<\/context>/, '').trim().length >= 200 && !t.includes('NOT-A-JOB'));
          const letter = users.some((t) => /cover letter/i.test(t.split('\n')[0]) || /^cover letter/i.test(t.replace(/[\s\S]*<\/context>\s*/, '')));
          return streamTool(res, params, 'make_document', { kind: letter ? 'letter' : 'tailor', job: posting ? 'pasted' : 'none', title: null, company: null });
        }
        const route = routeLike(params);
        if (route?.say) return streamText(res, params, [route.say]);
        if (route) return streamTool(res, params, route.name, route.input);
      }
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

/** What the real model is told to do with the chat tools, approximated for tests (first line = the request). */
function routeLike(params) {
  const raw = params.messages.at(-1).content;
  const text = raw.includes('</context>') ? raw.slice(raw.indexOf('</context>') + 10).trim() : raw.trim();
  const [first, ...rest] = text.split('\n');
  const line = first.toLowerCase();
  const pasted = rest.join('\n').trim();
  // A concern about the pasted posting: the model answers first; "I'm eligible" then starts tailoring that posting.
  if (/ELIGIBILITY-CHECK/.test(text)) return { say: 'Note: this role requires US residency. Are you eligible?' };
  if (/^i('| a)?m eligible/.test(line)) return { name: 'make_document', input: { kind: 'tailor', job: 'pasted', title: 'Senior Product Manager', company: 'Sample Pay' } };
  if (/NOT-A-JOB/.test(text)) return { say: "That looks like a résumé, not a job description. Paste the job description and I'll tailor your résumé to it." };
  if (/\?\s*$/.test(line) && /^(should|how|what|why|is|do|does|which)\b/.test(line)) return null;
  if (/\b(mock|practi[sc]e|simulat\w*)\b/.test(line) && /interview/.test(line)) return { name: 'mock_interview', input: { job: pasted.length >= 200 ? 'pasted' : 'current', instructions: null, title: null, company: null } };
  if (/\b(prep|interview|likely questions|study plan)\b/.test(line) && !/\?\s*$/.test(line)) return { name: 'prep_guide', input: { job: pasted.length >= 200 ? 'pasted' : 'current', instructions: line, title: null, company: null } };
  if (/\b(cards?|show)\b/.test(line) && /\b(seen|recent|shown)\b/.test(line)) return { name: 'show_jobs', input: { which: 'recent' } };
  // A model mistake to guard against: picking a new search for jobs they already have.
  if (/^bring back\b/.test(line)) return { name: 'find_jobs', input: { anywhere: false } };
  if (/\b(seen|saved|past)\b/.test(line)) return { say: 'From your saved and recent jobs: Product Manager, Payments at Sample Pay.' };
  if (/\b(find|show|get|any|search)\b.*\b(jobs?|roles?|openings?)\b/.test(line)) return { name: 'find_jobs', input: { anywhere: /anywhere/.test(line) } };
  const cv = /\b(cv|r[eé]s?u?m[eé]?s?)\b/.test(line);
  const letter = /cover letter/.test(line);
  const kind = cv && letter && /\b(and|both|plus|with)\b|\+/.test(line) ? 'both' : /\b(tailor|customi[sz]e|adapt)/.test(line) && cv ? 'tailor' : letter && /\b(write|draft|make|create|please)\b/.test(line) ? 'letter' : /\b(improve|stronger|strengthen)\b/.test(line) && cv ? 'improve' : null;
  if (!kind) return null;
  const job = kind === 'improve' ? 'none' : pasted.length >= 200 ? 'pasted' : raw.includes('<job>') || params.messages.some((m) => m.content.includes('<job>')) ? 'current' : 'none';
  const tone = /\b(warm|formal|short)\b/.test(line) ? line.match(/(warm[^,.]*|formal[^,.]*|short[^,.]*)/)[0].trim() : null;
  return { name: 'make_document', input: { kind, job, title: job === 'pasted' ? 'Product Manager, Payments' : null, company: job === 'pasted' ? 'Sample Pay' : null, ...(tone ? { tone } : {}) } };
}

function streamTool(res, params, name, input) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send('message_start', { type: 'message_start', message: { id: 'msg_fake', type: 'message', role: 'assistant', model: params.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 50, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
  send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_fake', name, input: {} } });
  send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } });
  send('content_block_stop', { type: 'content_block_stop', index: 0 });
  send('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } });
  send('message_stop', { type: 'message_stop' });
  res.end();
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
