// mammoth ships types for its Node entry only; this is the slice of its browser build that src/lib/career/parse.ts uses.
declare module 'mammoth/mammoth.browser.js' {
  type Extract = (input: { arrayBuffer: ArrayBuffer }) => Promise<{ value: string }>;
  export const extractRawText: Extract | undefined;
  const mammoth: { extractRawText: Extract } | undefined;
  export default mammoth;
}
