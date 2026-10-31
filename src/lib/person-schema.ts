import { isPlaceholder, type Resume } from './resume-parse';
import { isCurrent } from './text';

/** schema.org Person for the home page, built only from résumé fields that are filled in. */
export function personSchema(resume: Resume, site: URL) {
  const { identity } = resume;
  const real = (v?: string) => (v && !isPlaceholder(v) ? v : undefined);
  const parts = identity.location.split('·')[0].split(',').map((s) => s.trim()).filter(Boolean);
  const [country, region, locality] = parts.reverse();
  const current = resume.experience.find((e) => isCurrent(e.dates));
  const degree = resume.education_and_certs.find((e) => /\b(B\.?Sc|B\.?A|M\.?Sc|MBA|Bachelor|Master|PhD)\b/i.test(e));
  const school = degree?.split(' — ')[1];

  const schema = {
    '@context': 'https://schema.org',
    '@type': 'Person',
    name: identity.name,
    alternateName: real(identity.nickname),
    jobTitle: real(identity.headline),
    description: real(identity.one_liner),
    url: site.href,
    image: new URL('/og.png', site).href,
    email: real(identity.email) && `mailto:${identity.email}`,
    address: real(country) && { '@type': 'PostalAddress', addressLocality: locality, addressRegion: region, addressCountry: country },
    sameAs: [identity.linkedin, identity.instagram].filter((u) => real(u)),
    worksFor: current && real(current.company) && { '@type': 'Organization', name: current.company },
    alumniOf: real(school) && { '@type': 'CollegeOrUniversity', name: school },
    knowsAbout: [...(resume.skills.ai ?? []), ...(resume.skills.product ?? []).slice(0, 8)],
  };
  // Drop empty fields, and keep "</script>" out of the inline JSON.
  return JSON.stringify(schema, (_, v) => (v === undefined || v === '' || (Array.isArray(v) && !v.length) ? undefined : v)).replace(/</g, '\\u003c');
}
