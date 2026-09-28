// Splits raw message content into tokens. Root mentions arrive as CommonMark
// links ("[@Alice](root://user/<id>)"), so a mention becomes one typed token
// with its ID instead of being split on spaces. Pure: no SDK imports.

export type TokenKind = "word" | "user" | "role" | "channel" | "emoji";

export interface Token {
  kind: TokenKind;
  /** Word text, or the link text for a mention ("@Alice"). */
  text: string;
  /** The ID for user/role/channel mentions; the shortcode for emoji. */
  id?: string;
  start: number;
  end: number;
}

const LINK = /\[([^\]]*)\]\(root:\/\/(user|role|channel|emoji)\/([^)\s]+)\)/y;

export function tokenize(content: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < content.length) {
    if (/\s/.test(content[i])) {
      i++;
      continue;
    }
    LINK.lastIndex = i;
    const m = LINK.exec(content);
    if (m) {
      tokens.push({ kind: m[2] as TokenKind, text: m[1], id: decodeURIComponent(m[3]), start: i, end: LINK.lastIndex });
      i = LINK.lastIndex;
      continue;
    }
    let j = i;
    while (j < content.length && !/\s/.test(content[j])) {
      // Stop before a mention glued to a word, e.g. "hi[@Bob](root://...)".
      if (content[j] === "[" && j > i) {
        LINK.lastIndex = j;
        if (LINK.test(content)) break;
      }
      j++;
    }
    tokens.push({ kind: "word", text: content.slice(i, j), start: i, end: j });
    i = j;
  }
  return tokens;
}

export interface ParsedCommand {
  /** Lowercased command name without the prefix. */
  name: string;
  args: Args;
}

/** Returns undefined when the content doesn't start with the prefix. */
export function parseCommand(content: string, prefix: string): ParsedCommand | undefined {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith(prefix)) return undefined;
  const body = trimmed.slice(prefix.length);
  const tokens = tokenize(body);
  const first = tokens[0];
  if (!first || first.kind !== "word" || first.start !== 0) return undefined;
  return { name: first.text.toLowerCase(), args: new Args(body, tokens.slice(1)) };
}

/** Consumes command arguments left to right. */
export class Args {
  private pos = 0;

  constructor(
    private readonly source: string,
    private readonly tokens: Token[],
  ) {}

  get remaining(): number {
    return this.tokens.length - this.pos;
  }

  peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  next(): Token | undefined {
    return this.tokens[this.pos++];
  }

  /** Next token as a plain word (lowercased), or undefined. */
  word(): string | undefined {
    const t = this.peek();
    if (!t || t.kind !== "word") return undefined;
    this.pos++;
    return t.text.toLowerCase();
  }

  /** Consumes the next token if it is a mention of the given kind. */
  mention(kind: "user" | "role" | "channel"): Token | undefined {
    const t = this.peek();
    if (!t || t.kind !== kind) return undefined;
    this.pos++;
    return t;
  }

  /** Everything not yet consumed, as the original text (mentions intact). */
  rest(): string {
    const t = this.peek();
    const text = t ? this.source.slice(t.start).trim() : "";
    this.pos = this.tokens.length;
    return text;
  }
}
