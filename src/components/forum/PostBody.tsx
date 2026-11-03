import { postParagraphs } from '../../lib/post-text.ts';

// React escapes the text, so no member-written HTML ever reaches the page.
export function PostBody({ text }: { text: string }) {
  return <>{postParagraphs(text).map((lines, i) => <p key={i}>{lines.map((pieces, j) => <span key={j}>
    {j > 0 && <br />}
    {pieces.map((piece, k) => piece.href ? <a key={k} href={piece.href} rel="nofollow ugc noopener noreferrer">{piece.text}</a> : piece.text)}
  </span>)}</p>)}</>;
}
