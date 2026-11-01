// Can this person apply from where they live? Remote jobs are often limited to some countries ("Colombia only") or to
// hiring time zones (Himalayas' "Philippines ± 0 hours"). Showing those to someone elsewhere wastes their time, so they
// are filtered out before ranking. Unclear locations are kept (the ranking then treats "can't apply from here" as a
// dealbreaker). No dependencies: the hourly ingest imports this too.

type Country = { code: string; names: string[]; regions: string[]; utc: number };

// Standard-time UTC offsets; for big countries, the most populated zone (cities below refine it).
const COUNTRIES: Country[] = [
  { code: 'ng', names: ['nigeria'], regions: ['africa', 'west africa', 'emea', 'sub-saharan africa'], utc: 1 },
  { code: 'gh', names: ['ghana'], regions: ['africa', 'west africa', 'emea', 'sub-saharan africa'], utc: 0 },
  { code: 'ke', names: ['kenya'], regions: ['africa', 'east africa', 'emea', 'sub-saharan africa'], utc: 3 },
  { code: 'ug', names: ['uganda'], regions: ['africa', 'east africa', 'emea', 'sub-saharan africa'], utc: 3 },
  { code: 'tz', names: ['tanzania'], regions: ['africa', 'east africa', 'emea', 'sub-saharan africa'], utc: 3 },
  { code: 'rw', names: ['rwanda'], regions: ['africa', 'east africa', 'emea', 'sub-saharan africa'], utc: 2 },
  { code: 'et', names: ['ethiopia'], regions: ['africa', 'east africa', 'emea', 'sub-saharan africa'], utc: 3 },
  { code: 'za', names: ['south africa'], regions: ['africa', 'southern africa', 'emea', 'sub-saharan africa'], utc: 2 },
  { code: 'eg', names: ['egypt'], regions: ['africa', 'north africa', 'emea', 'middle east', 'mena'], utc: 2 },
  { code: 'ma', names: ['morocco'], regions: ['africa', 'north africa', 'emea', 'mena'], utc: 1 },
  { code: 'cm', names: ['cameroon'], regions: ['africa', 'emea', 'sub-saharan africa'], utc: 1 },
  { code: 'sn', names: ['senegal'], regions: ['africa', 'west africa', 'emea', 'sub-saharan africa'], utc: 0 },
  { code: 'ci', names: ["cote d'ivoire", 'ivory coast'], regions: ['africa', 'west africa', 'emea', 'sub-saharan africa'], utc: 0 },
  { code: 'gb', names: ['united kingdom', 'uk', 'great britain', 'england', 'scotland', 'wales'], regions: ['europe', 'emea'], utc: 0 },
  { code: 'ie', names: ['ireland'], regions: ['europe', 'eu', 'emea'], utc: 0 },
  { code: 'pt', names: ['portugal'], regions: ['europe', 'eu', 'emea'], utc: 0 },
  { code: 'es', names: ['spain'], regions: ['europe', 'eu', 'emea'], utc: 1 },
  { code: 'fr', names: ['france'], regions: ['europe', 'eu', 'emea'], utc: 1 },
  { code: 'de', names: ['germany'], regions: ['europe', 'eu', 'emea', 'dach'], utc: 1 },
  { code: 'nl', names: ['netherlands'], regions: ['europe', 'eu', 'emea'], utc: 1 },
  { code: 'be', names: ['belgium'], regions: ['europe', 'eu', 'emea'], utc: 1 },
  { code: 'it', names: ['italy'], regions: ['europe', 'eu', 'emea'], utc: 1 },
  { code: 'pl', names: ['poland'], regions: ['europe', 'eu', 'emea'], utc: 1 },
  { code: 'se', names: ['sweden'], regions: ['europe', 'eu', 'emea', 'nordics'], utc: 1 },
  { code: 'ch', names: ['switzerland'], regions: ['europe', 'emea', 'dach'], utc: 1 },
  { code: 'at', names: ['austria'], regions: ['europe', 'eu', 'emea', 'dach'], utc: 1 },
  { code: 'ro', names: ['romania'], regions: ['europe', 'eu', 'emea'], utc: 2 },
  { code: 'ua', names: ['ukraine'], regions: ['europe', 'emea'], utc: 2 },
  { code: 'tr', names: ['turkey', 'türkiye', 'turkiye'], regions: ['europe', 'emea', 'middle east'], utc: 3 },
  { code: 'il', names: ['israel'], regions: ['emea', 'middle east'], utc: 2 },
  { code: 'ae', names: ['united arab emirates', 'uae', 'dubai'], regions: ['emea', 'middle east', 'mena'], utc: 4 },
  { code: 'sa', names: ['saudi arabia'], regions: ['emea', 'middle east', 'mena'], utc: 3 },
  { code: 'in', names: ['india'], regions: ['asia', 'apac', 'south asia'], utc: 5.5 },
  { code: 'pk', names: ['pakistan'], regions: ['asia', 'apac', 'south asia'], utc: 5 },
  { code: 'bd', names: ['bangladesh'], regions: ['asia', 'apac', 'south asia'], utc: 6 },
  { code: 'ph', names: ['philippines'], regions: ['asia', 'apac', 'southeast asia'], utc: 8 },
  { code: 'sg', names: ['singapore'], regions: ['asia', 'apac', 'southeast asia'], utc: 8 },
  { code: 'my', names: ['malaysia'], regions: ['asia', 'apac', 'southeast asia'], utc: 8 },
  { code: 'id', names: ['indonesia'], regions: ['asia', 'apac', 'southeast asia'], utc: 7 },
  { code: 'vn', names: ['vietnam'], regions: ['asia', 'apac', 'southeast asia'], utc: 7 },
  { code: 'th', names: ['thailand'], regions: ['asia', 'apac', 'southeast asia'], utc: 7 },
  { code: 'cn', names: ['china'], regions: ['asia', 'apac'], utc: 8 },
  { code: 'jp', names: ['japan'], regions: ['asia', 'apac'], utc: 9 },
  { code: 'kr', names: ['south korea', 'korea'], regions: ['asia', 'apac'], utc: 9 },
  { code: 'au', names: ['australia'], regions: ['apac', 'oceania', 'anz'], utc: 10 },
  { code: 'nz', names: ['new zealand'], regions: ['apac', 'oceania', 'anz'], utc: 12 },
  { code: 'us', names: ['united states', 'usa', 'us', 'u.s.', 'u.s.a.'], regions: ['americas', 'north america'], utc: -5 },
  { code: 'ca', names: ['canada'], regions: ['americas', 'north america'], utc: -5 },
  { code: 'mx', names: ['mexico'], regions: ['americas', 'latam', 'latin america', 'north america'], utc: -6 },
  { code: 'br', names: ['brazil', 'brasil'], regions: ['americas', 'latam', 'latin america', 'south america'], utc: -3 },
  { code: 'ar', names: ['argentina'], regions: ['americas', 'latam', 'latin america', 'south america'], utc: -3 },
  { code: 'co', names: ['colombia'], regions: ['americas', 'latam', 'latin america', 'south america'], utc: -5 },
  { code: 'cl', names: ['chile'], regions: ['americas', 'latam', 'latin america', 'south america'], utc: -4 },
  { code: 'pe', names: ['peru'], regions: ['americas', 'latam', 'latin america', 'south america'], utc: -5 },
];

/** Places inside a country that people write without the country name, with their own offset. */
const CITIES: [RegExp, string, number?][] = [
  [/\b(lagos|ibadan|abuja|port harcourt|kano|enugu|benin city|abeokuta|ilorin)\b/i, 'ng'],
  [/\b(accra|kumasi)\b/i, 'gh'],
  [/\b(nairobi|mombasa)\b/i, 'ke'],
  [/\b(cape town|johannesburg|durban|pretoria)\b/i, 'za'],
  [/\b(cairo|alexandria)\b/i, 'eg'],
  [/\b(kampala)\b/i, 'ug'],
  [/\b(kigali)\b/i, 'rw'],
  [/\b(ontario|toronto|ottawa|waterloo|mississauga|quebec|québec|montr[eé]al|nova scotia|new brunswick)\b/i, 'ca', -5],
  [/\b(manitoba|winnipeg|saskatchewan)\b/i, 'ca', -6],
  [/\b(alberta|calgary|edmonton)\b/i, 'ca', -7],
  [/\b(british columbia|vancouver|victoria)\b/i, 'ca', -8],
  [/\b(california|san francisco|los angeles|seattle|washington state|oregon|portland)\b/i, 'us', -8],
  [/\b(texas|austin|dallas|houston|chicago|illinois|minnesota)\b/i, 'us', -6],
  [/\b(denver|colorado|arizona|phoenix|utah)\b/i, 'us', -7],
  [/\b(new york|boston|massachusetts|florida|miami|atlanta|georgia|washington,? d\.?c\.?)\b/i, 'us', -5],
  [/\b(london|manchester|edinburgh|birmingham)\b/i, 'gb'],
  [/\b(berlin|munich|hamburg)\b/i, 'de'],
  [/\b(paris)\b/i, 'fr'],
  [/\b(amsterdam|rotterdam)\b/i, 'nl'],
  [/\b(madrid|barcelona)\b/i, 'es'],
  [/\b(lisbon|porto)\b/i, 'pt'],
  [/\b(bengaluru|bangalore|mumbai|delhi|hyderabad|pune|chennai)\b/i, 'in'],
  [/\b(manila|cebu)\b/i, 'ph'],
  [/\b(sydney|melbourne|brisbane)\b/i, 'au'],
  [/\b(s[aã]o paulo|rio de janeiro)\b/i, 'br'],
  [/\b(bogot[aá]|medell[ií]n)\b/i, 'co'],
];

const OPEN = /\b(worldwide|anywhere|global(ly)?|all countries|any country|any location|international)\b/i;
const BY_CODE = new Map(COUNTRIES.map((c) => [c.code, c]));
const REGION_WORDS = [...new Set(COUNTRIES.flatMap((c) => c.regions))];
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const word = (w: string) => new RegExp(`(^|[^\\p{L}])${escape(w)}($|[^\\p{L}])`, 'iu');
const NAME_RE = COUNTRIES.map((c) => ({ code: c.code, re: c.names.map(word) }));
const REGION_RE = REGION_WORDS.map((r) => ({ region: r, re: word(r) }));

/** `from`: the résumé/profile location, or (when that names no country) the visitor's network (Vercel's geo headers). */
export type Place = { country: string | null; name: string | null; regions: string[]; utc: number | null; from: 'profile' | 'network' | null };

/** Where the visitor is: country, the regions it belongs to and its UTC offset (city first, then country). */
export function placeOf(location: string | null | undefined): Place {
  const text = location ?? '';
  const city = CITIES.find(([re]) => re.test(text));
  const byName = NAME_RE.find((c) => c.re.some((re) => re.test(text)));
  const code = byName?.code ?? city?.[1] ?? null;
  const country = code ? BY_CODE.get(code)! : null;
  const utc = city && city[1] === code && city[2] !== undefined ? city[2] : (country?.utc ?? null);
  return { country: code, name: country?.names[0] ? title(country.names[0]) : null, regions: country?.regions ?? [], utc, from: code ? 'profile' : null };
}

/** UTC offset (hours) of an IANA time zone right now, e.g. "Africa/Lagos" → 1. */
function offsetOf(timeZone: string): number | null {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'shortOffset' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value ?? '';
    const m = part.match(/GMT([+-]\d{1,2})(?::(\d{2}))?/);
    return part === 'GMT' ? 0 : m ? Number(m[1]) + Math.sign(Number(m[1])) * (Number(m[2] ?? 0) / 60) : null;
  } catch {
    return null;
  }
}

/**
 * The profile's place, or, if it names no country, the visitor's country from their network: Vercel adds
 * `x-vercel-ip-country` (ISO code) and `x-vercel-ip-timezone` to every request. Nothing is looked up or stored.
 */
export function placeFor(location: string | null | undefined, headers?: Headers): Place {
  const fromProfile = placeOf(location);
  if (fromProfile.country || !headers) return fromProfile;
  const code = headers.get('x-vercel-ip-country')?.trim().toLowerCase();
  if (!code || !/^[a-z]{2}$/.test(code)) return fromProfile;
  const country = BY_CODE.get(code);
  const tz = headers.get('x-vercel-ip-timezone');
  return { country: code, name: country ? title(country.names[0]) : code.toUpperCase(), regions: country?.regions ?? [], utc: (tz ? offsetOf(tz) : null) ?? country?.utc ?? null, from: 'network' };
}

/** The Place for a country code (used by discovery to check a board really hires there). */
export function countryPlace(code: string): Place {
  const c = BY_CODE.get(code);
  return { country: code, name: c ? title(c.names[0]) : code.toUpperCase(), regions: c?.regions ?? [], utc: c?.utc ?? null, from: null };
}

/** Does this job name the visitor's own country (or a city in it)? Those come first. */
export function inCountry(jobLocation: string, place: Place): boolean {
  if (!place.country) return false;
  const c = NAME_RE.find((x) => x.code === place.country);
  return !!c?.re.some((re) => re.test(jobLocation)) || CITIES.some(([re, code]) => code === place.country && re.test(jobLocation));
}

const title = (s: string) => (s.length <= 3 ? s.toUpperCase() : s.replace(/\b\p{L}/gu, (c) => c.toUpperCase()));

/**
 * Can someone in `place` take this remote job? 'yes' (open worldwide, or names their country/region), 'no' (names only
 * other countries/regions), 'unknown' (nothing recognisable: kept, the ranking decides).
 */
export function eligibleFrom(jobLocation: string, place: Place): 'yes' | 'no' | 'unknown' {
  const text = jobLocation.trim();
  if (!text || OPEN.test(text)) return 'yes';
  const countries = NAME_RE.filter((c) => c.re.some((re) => re.test(text))).map((c) => c.code);
  const cities = CITIES.filter(([re]) => re.test(text)).map(([, code]) => code);
  const regions = REGION_RE.filter((r) => r.re.test(text)).map((r) => r.region);
  if (!countries.length && !cities.length && !regions.length) return 'unknown';
  if (!place.country) return 'unknown';
  if (countries.includes(place.country) || cities.includes(place.country) || regions.some((r) => place.regions.includes(r))) return 'yes';
  return 'no';
}

/** Hiring time zones (UTC offsets, e.g. Himalayas): within 3 hours of one of them counts; no data = no limit. */
export const TIMEZONE_SLACK_H = 3;
export function timezoneFits(timezones: number[] | undefined, place: Place): boolean {
  if (!timezones?.length || place.utc === null) return true;
  return timezones.some((tz) => Math.abs(tz - place.utc!) <= TIMEZONE_SLACK_H);
}

/** "Worldwide" / "Africa" / "Colombia": who can apply, for the card. */
export function remoteLabel(jobLocation: string): string {
  const text = jobLocation.trim();
  return !text || OPEN.test(text) ? 'Worldwide' : text;
}
