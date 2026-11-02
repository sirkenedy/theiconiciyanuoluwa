// Résumé file → plain text, entirely in the browser (career-mode.md §3.2). The parsers load only when a file is picked.
// Files are read as data and never rendered or executed.

export const MAX_BYTES = 5 * 1024 * 1024;
export type Kind = 'pdf' | 'docx';
export class ParseError extends Error {
  code: 'type' | 'size' | 'empty' | 'scanned' | 'broken';
  /** Why a file couldn't be read (the error's name and message, never the file's content), shown for diagnosis. */
  detail: string;
  constructor(code: ParseError['code'], detail = '') {
    super(code);
    this.code = code;
    this.detail = detail;
  }
}

export function kindOf(file: File): Kind | null {
  const name = file.name.toLowerCase();
  if (name.endsWith('.pdf') || file.type === 'application/pdf') return 'pdf';
  if (name.endsWith('.docx') || file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx';
  return null;
}

type TrustedTypesWindow = { trustedTypes?: { createPolicy(name: string, rules: { createScriptURL(u: string): string }): { createScriptURL(u: string): string } } };

async function pdfText(data: ArrayBuffer): Promise<string> {
  const [pdfjs, { default: workerUrl }] = await Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]);
  if (!pdfjs.GlobalWorkerOptions.workerPort) {
    // Under Trusted Types a Worker needs a TrustedScriptURL. This policy vouches for exactly one URL: our bundled worker.
    const tt = (window as unknown as TrustedTypesWindow).trustedTypes;
    const policy = tt?.createPolicy('pdf-worker', { createScriptURL: (u) => (u === workerUrl ? u : '') });
    pdfjs.GlobalWorkerOptions.workerPort = new Worker((policy ? policy.createScriptURL(workerUrl) : workerUrl) as string, { type: 'module' });
  }
  const task = pdfjs.getDocument({ data, useSystemFonts: true });
  const doc = await task.promise;
  const pages: string[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const content = await (await doc.getPage(n)).getTextContent();
    let line = '';
    let lastEnd: number | null = null;
    const lines: string[] = [];
    for (const item of content.items) {
      if (!('str' in item)) continue;
      // Ligatures and style changes split words into several items; only a real horizontal gap is a space.
      const x = item.transform[4];
      const size = Math.hypot(item.transform[0], item.transform[1]) || 10;
      if (lastEnd !== null && x - lastEnd > size * 0.2 && !line.endsWith(' ') && !item.str.startsWith(' ')) line += ' ';
      line += item.str;
      lastEnd = x + item.width;
      if (item.hasEOL) {
        lines.push(line);
        line = '';
        lastEnd = null;
      }
    }
    if (line.trim()) lines.push(line);
    pages.push(lines.map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n'));
  }
  await task.destroy();
  return pages.join('\n\n');
}

async function docxText(data: ArrayBuffer): Promise<string> {
  const mammoth = await import('mammoth/mammoth.browser.js');
  const extract = mammoth.extractRawText ?? mammoth.default!.extractRawText;
  const { value } = await extract({ arrayBuffer: data });
  return value.replace(/\n{3,}/g, '\n\n').trim();
}

/** Text of the résumé, or a ParseError explaining what went wrong in plain terms. */
export async function readResume(file: File): Promise<string> {
  const kind = kindOf(file);
  if (!kind) throw new ParseError('type');
  if (file.size > MAX_BYTES) throw new ParseError('size');
  if (file.size === 0) throw new ParseError('empty');
  let text: string;
  try {
    text = kind === 'pdf' ? await pdfText(await file.arrayBuffer()) : await docxText(await file.arrayBuffer());
  } catch (err) {
    const e = err as Error;
    const detail = `${kind.toUpperCase()} · ${e?.name ?? 'Error'}: ${String(e?.message ?? err).slice(0, 160)} · ${file.type || 'no type'} · ${Math.round(file.size / 1024)} KB`;
    console.warn('[résumé] could not read the file:', detail);
    throw new ParseError('broken', detail);
  }
  // A PDF with pages but (almost) no text layer is a scan: say so and offer to paste instead.
  if (text.replace(/\s/g, '').length < 80) throw new ParseError(kind === 'pdf' ? 'scanned' : 'empty');
  return text;
}

/** Emails and phone numbers aren't needed to coach anyone, so they never leave the device. */
export const withoutContacts = (text: string) =>
  text
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[email]')
    .replace(/(?<![\w/])(\+?\d[\d\s().-]{7,}\d)(?![\w/])/g, (m) => (m.replace(/\D/g, '').length >= 9 ? '[phone]' : m));
