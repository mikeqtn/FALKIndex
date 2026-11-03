// Forum posts are plain text: blank lines start paragraphs, line breaks are kept, and only
// http(s) links become clickable (never trailing punctuation). Kept free of server imports so
// the browser bundle can use it; PostBody.tsx renders the result and React escapes the text.
const LINK = /(https?:\/\/[^\s<>"]*[^\s<>".,;:!?)\]'])/;
export type Piece = { text: string, href?: string };

/** Paragraphs, each a list of lines, each a list of text and link pieces. */
export const postParagraphs = (text: string): Piece[][][] => text.trim().split(/\n\s*\n/).map(paragraph =>
  paragraph.split('\n').map(line => line.split(LINK).filter(Boolean).map(part => LINK.test(part) ? { text:part, href:part } : { text:part })));
