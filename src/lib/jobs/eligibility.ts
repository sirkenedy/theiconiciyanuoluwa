// Who can apply, read from the posting's own words (no model call). "limited" wins over "open": a posting that offers
// relocation but can't sponsor a visa is still closed to someone who needs one.
export type Eligibility = { kind: 'open' | 'limited'; label: string };

const LIMITED: [RegExp, string][] = [
  [/\b(security|secret|government) clearance\b/, 'Needs security clearance'],
  [/\b(must|required to|need to|should) (be|hold|have)( a| an)? ([a-z.]+ )?(citizen(ship)?|permanent residen(t|cy)|green card)\b|\b(citizens?|permanent residents?|green card holders?) only\b|\bcitizenship (is )?required\b/, 'Citizens or PR only'],
  [/\b(no|not offering|without) (visa |immigration )?sponsorship\b|\b(unable|not able|cannot|can ?not|can't|won't|will not|do not|does not|don't|doesn't|are not able to) (to )?(provide |offer |support )?(visa |immigration |employment )?sponsor(ship)?\b|\bsponsorship (is )?not (available|provided|offered)\b/, 'No visa sponsorship'],
  [/\b(not|never|won't|will not)( now or in the future| now or in future)? (require|need) (a )?(visa |employer |immigration |employment )?sponsorship\b|\bwithout (requiring|needing) (visa |employer )?sponsorship\b/, 'No visa sponsorship'],
  [/\b(legally )?(authori[sz]ed|eligible|entitled|permitted) to work in [a-z .]{2,30}?( without| with no)( the need for)?( (visa|employer|future))? sponsorship\b/, 'No visa sponsorship'],
  [/\b(canadian|local|us|u\.s\.) (work )?experience (is )?(required|a must|mandatory)\b/, 'Wants local experience'],
];
const OPEN: [RegExp, string][] = [
  [/\b(visa|immigration|work permit) (sponsorship|support) (is )?(available|provided|offered)\b|\b(we|company) (can|will|do|does|are able to) (provide |offer )?sponsor\b|\bsponsorship (is )?(available|provided|offered)\b|\bwill sponsor\b|\bopen to sponsor/, 'Sponsors visas'],
  [/\brelocation (support|assistance|package|bonus|help) (is )?(available|provided|offered|included)?\b|\bwe (offer|provide) relocation\b|\bhelp (you )?relocate\b/, 'Relocation support'],
];

export function eligibility(text: string): Eligibility | undefined {
  const t = text.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ');
  for (const [re, label] of LIMITED) if (re.test(t)) return { kind: 'limited', label };
  const noRelocation = /\bno relocation\b|\brelocation (is )?not (available|provided|offered)\b/.test(t);
  for (const [re, label] of OPEN) if (re.test(t) && !(noRelocation && label === 'Relocation support')) return { kind: 'open', label };
  return undefined;
}
