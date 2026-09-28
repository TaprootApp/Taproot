import React from "react";
import styles from "./MessagePreview.module.css";
import { cx } from "../lib/cx";

// A small, safe renderer for Root message markdown: **bold**, *italic*,
// _italic_, ~~strike~~, `code`, ```code blocks```, > quotes, line breaks and
// [text](url) links. root:// links (user/role/channel mentions) render as
// chips showing their link text, like Root does. Everything is built as
// React elements, never HTML strings, so message text can't inject markup.

export interface MessagePreviewProps {
  /** Message markdown. */
  content: string;
  /** Show as a chat message from this author (e.g. "Taproot"); omit for bare text. */
  author?: string;
  /** Highlight {placeholders} such as {user} in templates. */
  placeholders?: boolean;
  /** Shown when content is empty. Default "Nothing to preview". */
  emptyText?: string;
  className?: string;
}

/** Renders message text the way it will look in Root (approximately). */
export const MessagePreview: React.FC<MessagePreviewProps> = ({
  content,
  author,
  placeholders = false,
  emptyText = "Nothing to preview",
  className,
}) => {
  const body = content.trim() ? (
    <div className={styles.body}>{renderBlocks(content, placeholders)}</div>
  ) : (
    <div className={styles.empty}>{emptyText}</div>
  );
  if (!author) return <div className={cx(styles.bare, className)}>{body}</div>;
  return (
    <div className={cx(styles.message, className)}>
      <div className={styles.avatar} aria-hidden>
        🌱
      </div>
      <div className={styles.main}>
        <div className={styles.meta}>
          <span className={styles.author}>{author}</span>
          <span className={styles.appTag}>APP</span>
          <span className={styles.time}>Today</span>
        </div>
        {body}
      </div>
    </div>
  );
};

function renderBlocks(text: string, placeholders: boolean): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  // Fenced code blocks first; odd segments are code.
  const parts = text.split(/```(?:[a-z0-9_-]*\n)?/i);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      out.push(
        <pre key={`c${i}`} className={styles.codeBlock}>
          <code>{part.replace(/\n$/, "")}</code>
        </pre>,
      );
      return;
    }
    const lines = part.split("\n");
    let quote: string[] = [];
    let plain: string[] = [];
    const flushQuote = () => {
      if (!quote.length) return;
      out.push(
        <blockquote key={`q${i}-${out.length}`} className={styles.quote}>
          {renderLines(quote, placeholders)}
        </blockquote>,
      );
      quote = [];
    };
    const flushPlain = () => {
      if (!plain.length) return;
      out.push(<React.Fragment key={`p${i}-${out.length}`}>{renderLines(plain, placeholders)}</React.Fragment>);
      plain = [];
    };
    for (const line of lines) {
      const m = /^>\s?(.*)$/.exec(line);
      if (m) {
        flushPlain();
        quote.push(m[1]);
      } else {
        flushQuote();
        plain.push(line);
      }
    }
    flushQuote();
    flushPlain();
  });
  return out;
}

function renderLines(lines: string[], placeholders: boolean): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  lines.forEach((line, i) => {
    if (i > 0) out.push(<br key={`br${i}`} />);
    out.push(<React.Fragment key={`l${i}`}>{renderInline(line, placeholders)}</React.Fragment>);
  });
  return out;
}

// Earliest match wins; groups: 1-2 code, 3-4 link, 5 bold, 6 strike, 7 *italic*, 8 _italic_.
const INLINE =
  /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|\[([^\]]*)\]\(([^)\s]+)\)|\*\*([\s\S]+?)\*\*|~~([\s\S]+?)~~|\*(?!\s)([\s\S]+?)\*|(?<![\w])_(?!\s)([\s\S]+?)_(?![\w])/;

function renderInline(text: string, placeholders: boolean): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let rest = text;
  let key = 0;
  while (rest) {
    const m = INLINE.exec(rest);
    if (!m) {
      out.push(...renderText(rest, placeholders, key++));
      break;
    }
    if (m.index > 0) out.push(...renderText(rest.slice(0, m.index), placeholders, key++));
    const k = key++;
    if (m[2] !== undefined) {
      out.push(
        <code key={k} className={styles.code}>
          {m[2]}
        </code>,
      );
    } else if (m[4] !== undefined) {
      out.push(renderLink(m[3], m[4], k, placeholders));
    } else if (m[5] !== undefined) {
      out.push(<strong key={k}>{renderInline(m[5], placeholders)}</strong>);
    } else if (m[6] !== undefined) {
      out.push(<s key={k}>{renderInline(m[6], placeholders)}</s>);
    } else {
      out.push(<em key={k}>{renderInline(m[7] ?? m[8], placeholders)}</em>);
    }
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

function renderLink(label: string, url: string, key: number, placeholders: boolean): React.ReactNode {
  const root = /^root:\/\/([a-z]+)\//i.exec(url);
  if (root) {
    const kind = root[1].toLowerCase();
    if (kind === "emoji") return <React.Fragment key={key}>{label}</React.Fragment>;
    const chipClass =
      kind === "channel" ? styles.channelChip : kind === "role" ? styles.roleChip : styles.mentionChip;
    return (
      <span key={key} className={cx(styles.chip, chipClass)} title={url}>
        {label || url}
      </span>
    );
  }
  if (/^https?:\/\//i.test(url)) {
    return (
      <a key={key} href={url} target="_blank" rel="noreferrer noopener" className={styles.link}>
        {label ? renderInline(label, placeholders) : url}
      </a>
    );
  }
  // Placeholder link targets like ({channel}) in templates: show as typed.
  return <React.Fragment key={key}>{`[${label}](${url})`}</React.Fragment>;
}

function renderText(text: string, placeholders: boolean, key: number): React.ReactNode[] {
  if (!placeholders) return [<React.Fragment key={key}>{text}</React.Fragment>];
  return text.split(/(\{[a-z_]+\})/i).map((part, i) =>
    /^\{[a-z_]+\}$/i.test(part) ? (
      <span key={`${key}-${i}`} className={styles.placeholder}>
        {part}
      </span>
    ) : (
      <React.Fragment key={`${key}-${i}`}>{part}</React.Fragment>
    ),
  );
}
