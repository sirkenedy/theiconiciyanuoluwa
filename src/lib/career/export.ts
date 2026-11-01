// DOCX (docx) and PDF (pdf-lib) downloads in one ATS-safe template: single column, real text, standard headings,
// system-safe fonts (career-mode.md §3.4). Generated in the browser; both libraries load only when a download is clicked.
import type { Doc, GuideDoc, LetterDoc } from './document.ts';
import type { TailoredResume } from './types.ts';

type Block = { kind: 'name' | 'contact' | 'heading' | 'role' | 'bullet' | 'text'; text: string; right?: string };

function resumeBlocks(r: TailoredResume, contact: string): Block[] {
  const out: Block[] = [{ kind: 'name', text: r.name ?? '' }];
  if (contact) out.push({ kind: 'contact', text: contact });
  if (r.summary) out.push({ kind: 'heading', text: 'Summary' }, { kind: 'text', text: r.summary });
  if (r.experience.length) {
    out.push({ kind: 'heading', text: 'Experience' });
    for (const e of r.experience) {
      out.push({ kind: 'role', text: [e.role, e.company].filter(Boolean).join(' · '), right: e.dates });
      for (const b of e.bullets) out.push({ kind: 'bullet', text: b });
    }
  }
  if (r.skills.length) {
    out.push({ kind: 'heading', text: 'Skills' });
    for (const g of r.skills) out.push({ kind: 'text', text: r.skills.length > 1 && g.group ? `${g.group}: ${g.items.join(' · ')}` : g.items.join(' · ') });
  }
  if (r.education.length) out.push({ kind: 'heading', text: 'Education' }, ...r.education.map((t) => ({ kind: 'text' as const, text: t })));
  if (r.certifications.length) out.push({ kind: 'heading', text: 'Certifications' }, ...r.certifications.map((t) => ({ kind: 'text' as const, text: t })));
  return out;
}

function letterBlocks(d: LetterDoc): Block[] {
  const date = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  return [
    { kind: 'name', text: d.name },
    ...(d.contact ? [{ kind: 'contact' as const, text: d.contact }] : []),
    { kind: 'text', text: date },
    ...d.letter.split(/\n{2,}/).map((p) => ({ kind: 'text' as const, text: p.replace(/\s*\n\s*/g, ' ').trim() })).filter((b) => b.text),
  ];
}

/** A prep guide as the same plain, readable blocks: title, sections, questions in bold, outlines as bullets. */
function guideBlocks(d: GuideDoc): Block[] {
  const g = d.guide;
  const out: Block[] = [{ kind: 'name', text: g.title }, { kind: 'contact', text: g.subtitle }];
  if (g.note) out.push({ kind: 'text', text: g.note });
  for (const s of g.sections) {
    out.push({ kind: 'heading', text: s.heading });
    if (s.intro) out.push({ kind: 'text', text: s.intro });
    s.items.forEach((item, i) => {
      if (item.title) out.push({ kind: 'role', text: item.kind === 'question' || item.kind === 'step' ? `${i + 1}. ${item.title}` : item.title });
      if (item.why) out.push({ kind: 'text', text: `Why they ask: ${item.why}` });
      if (item.text) out.push({ kind: 'text', text: item.text });
      for (const b of [...item.bullets, ...item.answer]) out.push({ kind: 'bullet', text: b });
    });
  }
  if (g.sources.length) {
    out.push({ kind: 'heading', text: 'Sources' });
    for (const s of g.sources) out.push({ kind: 'bullet', text: `${s.title}: ${s.url}` });
  }
  return out;
}

export const blocksFor = (doc: Doc) => (doc.kind === 'resume' ? resumeBlocks(doc.tailored, doc.contact) : doc.kind === 'letter' ? letterBlocks(doc) : guideBlocks(doc));

export async function toDocx(blocks: Block[]): Promise<Blob> {
  const { AlignmentType, BorderStyle, Document, LevelFormat, Packer, Paragraph, TabStopType, TextRun } = await import('docx');
  const RIGHT = 9638; // A4 text width in twips with 2 cm margins
  const children = blocks.map((b) => {
    switch (b.kind) {
      case 'name':
        return new Paragraph({ children: [new TextRun({ text: b.text, bold: true, size: 36 })], spacing: { after: 60 } });
      case 'contact':
        return new Paragraph({ children: [new TextRun({ text: b.text, size: 20 })], spacing: { after: 200 } });
      case 'heading':
        return new Paragraph({
          children: [new TextRun({ text: b.text.toUpperCase(), bold: true, size: 21 })],
          spacing: { before: 240, after: 80 },
          border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: 'BBBBBB', space: 2 } },
        });
      case 'role':
        return new Paragraph({
          children: [new TextRun({ text: b.text, bold: true }), ...(b.right ? [new TextRun({ text: `\t${b.right}` })] : [])],
          tabStops: [{ type: TabStopType.RIGHT, position: RIGHT }],
          spacing: { before: 120, after: 40 },
        });
      case 'bullet':
        return new Paragraph({ children: [new TextRun(b.text)], numbering: { reference: 'bullets', level: 0 }, spacing: { after: 40 } });
      default:
        return new Paragraph({ children: [new TextRun(b.text)], spacing: { after: 100 } });
    }
  });
  const doc = new Document({
    styles: { default: { document: { run: { font: 'Arial', size: 21 } } } },
    numbering: {
      config: [{ reference: 'bullets', levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 360, hanging: 260 } } } }] }],
    },
    sections: [{ properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } } }, children }],
  });
  return Packer.toBlob(doc);
}

/** pdf-lib's standard fonts speak WinAnsi only: map the few characters résumés use outside it, drop the rest. */
const toWinAnsi = (s: string) =>
  s
    .replace(/→/g, '->')
    .replace(/[✓✔]/g, '-')
    .replace(/[→-⇿]/g, '-')
    .replace(/[^\x09\x0a\x20-\x7e\xa0-\xff€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ]/g, '');

export async function toPdf(blocks: Block[], title: string): Promise<Blob> {
  const { PDFDocument, StandardFonts, grayscale } = await import('pdf-lib');
  // Print-safe greys (the PDF is a document, not themed UI): ink, secondary text, rules.
  const INK = grayscale(0.1);
  const SOFT = grayscale(0.28);
  const RULE = grayscale(0.73);
  const pdf = await PDFDocument.create();
  pdf.setTitle(toWinAnsi(title));
  pdf.setCreator('Ami, career coach');
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const [W, H, M] = [595.28, 841.89, 50];
  let page = pdf.addPage([W, H]);
  let y = H - M;
  const ensure = (h: number) => {
    if (y - h < M) {
      page = pdf.addPage([W, H]);
      y = H - M;
    }
  };
  const wrap = (text: string, font: typeof regular, size: number, width: number) => {
    const lines: string[] = [];
    let line = '';
    for (const word of toWinAnsi(text).split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) > width && line) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    if (line) lines.push(line);
    return lines;
  };
  const write = (text: string, font: typeof regular, size: number, x: number, width: number, gapAfter: number, color = INK) => {
    for (const l of wrap(text, font, size, width)) {
      ensure(size * 1.35);
      y -= size * 1.35;
      page.drawText(l, { x, y, size, font, color });
    }
    y -= gapAfter;
  };
  const textW = W - 2 * M;
  for (const b of blocks) {
    if (b.kind === 'name') write(b.text, bold, 18, M, textW, 2);
    else if (b.kind === 'contact') write(b.text, regular, 9.5, M, textW, 10, SOFT);
    else if (b.kind === 'heading') {
      ensure(30);
      y -= 10;
      write(b.text.toUpperCase(), bold, 10, M, textW, 3);
      page.drawLine({ start: { x: M, y: y + 1 }, end: { x: W - M, y: y + 1 }, thickness: 0.6, color: RULE });
      y -= 5;
    } else if (b.kind === 'role') {
      const right = toWinAnsi(b.right ?? '');
      const rw = right ? regular.widthOfTextAtSize(right, 10.5) : 0;
      ensure(18);
      y -= 4;
      const lines = wrap(b.text, bold, 10.5, textW - rw - 12);
      lines.forEach((l, i) => {
        ensure(14);
        y -= 14.2;
        page.drawText(l, { x: M, y, size: 10.5, font: bold, color: INK });
        if (i === 0 && right) page.drawText(right, { x: W - M - rw, y, size: 10.5, font: regular, color: SOFT });
      });
      y -= 2;
    } else if (b.kind === 'bullet') {
      const lines = wrap(b.text, regular, 10.5, textW - 14);
      lines.forEach((l, i) => {
        ensure(14.2);
        y -= 14.2;
        if (i === 0) page.drawText('•', { x: M + 2, y, size: 10.5, font: regular });
        page.drawText(l, { x: M + 14, y, size: 10.5, font: regular, color: INK });
      });
      y -= 2;
    } else write(b.text, regular, 10.5, M, textW, 6);
  }
  return new Blob([(await pdf.save()) as Uint8Array<ArrayBuffer>], { type: 'application/pdf' });
}

export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
