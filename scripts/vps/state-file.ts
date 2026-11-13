/**
 * The relay's saved state, written and read a conversation at a time.
 *
 * `workspace.json` holds everything the relay keeps of a workspace, every conversation with all
 * its recorded work. It was written as one JSON text and read back as one, and a text holds at
 * most 536,870,888 characters: on 2026-11-13 the owner's file was 465 MB and growing by about
 * 20 MB a day, days from the size at which no change could be saved any more and a restarted
 * relay could not read its own data. The file is the same JSON document as before, so an earlier
 * release reads what this one writes; only how it is put together and taken apart changed.
 * Nothing here is a limit on what a workspace holds.
 */
import { closeSync, fsyncSync, openSync, readSync, writeSync } from 'node:fs';

/** What is written a part at a time: the conversations of a state's workspace. */
export type State = Record<string, unknown> & {
  workspace: Record<string, unknown> & { conversations: unknown[] };
};

/** `{"a":1` from `{"a":1}`, ready for another field. */
const opened = (fields: Record<string, unknown>) => {
  const text = JSON.stringify(fields).slice(0, -1);
  return text.length > 1 ? `${text},` : text;
};

/**
 * The JSON of `state` in pieces, none longer than one conversation's: what `JSON.stringify`
 * would write, but for the order of its fields.
 */
export function* stateParts(state: State): Generator<string> {
  const { workspace, ...head } = state;
  const { conversations, ...meta } = workspace;
  yield `${opened(head)}"workspace":${opened(meta)}"conversations":[`;
  for (let index = 0; index < conversations.length; index++)
    yield `${index ? ',' : ''}${JSON.stringify(conversations[index])}`;
  yield ']}}';
}

/**
 * Writes `state` to a new file at `path` and flushes it to disk, each conversation written by
 * itself.
 */
export function writeState(path: string, state: State, mode = 0o600): void {
  const fd = openSync(path, 'w', mode);
  try {
    // Small pieces go out together, a large conversation by itself.
    let pending: string[] = [];
    let size = 0;
    const flush = () => {
      if (pending.length) writeSync(fd, pending.join(''));
      pending = [];
      size = 0;
    };
    const write = (text: string) => {
      pending.push(text);
      size += text.length;
      if (size > 1 << 22) flush();
    };
    for (const part of stateParts(state)) write(part);
    flush();
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

const quote = 34;
const backslash = 92;
const comma = 44;
const openBrace = 123;
const closeBrace = 125;
const openBracket = 91;
const closeBracket = 93;
const unreadable = () => new SyntaxError('The saved state is not the JSON this relay writes.');

/**
 * Reads the state a file holds, as `JSON.parse` of its text would, without ever holding that
 * text: the file is read a few megabytes at a time, each conversation of its workspace is parsed
 * by itself as its end is reached, and the rest of the document, which is small, at the end.
 * Any JSON document is read, however it is laid out; one without `workspace.conversations` is
 * simply parsed.
 */
export function readState(path: string, chunkBytes = 1 << 24): unknown {
  const conversations: unknown[] = [];
  const value = scanState(
    path,
    (conversation) => void conversations.push(conversation),
    chunkBytes,
  );
  const held = (value as { workspace?: { conversations?: unknown[] } } | null)?.workspace
    ?.conversations;
  // Empty where they were handed over one by one, which is where they go back.
  if (Array.isArray(held)) for (const conversation of conversations) held.push(conversation);
  return value;
}

/**
 * Reads a state file like `readState`, handing each conversation to `take` as it is read
 * instead of keeping it, and returns the rest of the document, its list of conversations left
 * empty: for a reader that looks at every conversation once, such as a count of the replies
 * still running. A document whose list is not where this relay writes it keeps its
 * conversations, and `take` gets none.
 */
export function scanState(
  path: string,
  take: (conversation: unknown) => void,
  chunkBytes = 1 << 24,
): unknown {
  const fd = openSync(path, 'r');
  try {
    // Everything outside the conversations, as it stands in the file.
    const rest: Buffer[] = [];
    let found = false;
    // The bytes of the conversation being read, from chunks before this one.
    let element: Buffer[] = [];
    // What the bytes since `from` are: part of the rest, of a conversation, or between two.
    let run: 'rest' | 'element' | 'between' = 'rest';
    let depth = 0;
    let inString = false;
    let escaped = false;
    // The two outer containers: whether each is an object, the field being read in it, and
    // whether a field's name comes next.
    const object = [false, false, false];
    const field: (string | undefined)[] = [undefined, undefined, undefined];
    const named = [false, false, false];
    // The bytes of a field name being read in one of them.
    let name: number[] | undefined;
    // Depth 3 inside the list: 4 is a conversation.
    const list = 3;
    for (;;) {
      const chunk = Buffer.allocUnsafe(chunkBytes);
      const length = readSync(fd, chunk, 0, chunkBytes, null);
      if (!length) break;
      let from = 0;
      const end = (at: number) => {
        if (at > from) {
          const bytes = chunk.subarray(from, at);
          if (run === 'rest') rest.push(bytes);
          else if (run === 'element') element.push(bytes);
        }
        from = at;
      };
      let at = 0;
      while (at < length) {
        if (inString) {
          // Most of the file is text: look only for where it ends.
          while (at < length) {
            const byte = chunk[at++];
            if (escaped) escaped = false;
            else if (byte === backslash) escaped = true;
            else if (byte === quote) {
              inString = false;
              break;
            }
            if (name) name.push(byte);
          }
          if (!inString && name) {
            field[depth] = Buffer.from(name).toString('utf8');
            named[depth] = false;
            name = undefined;
          }
          continue;
        }
        const byte = chunk[at];
        // Between two conversations: only a conversation or the list's end may follow.
        if (run === 'between') {
          if (byte === openBrace) {
            end(at);
            run = 'element';
            depth++;
          } else if (byte === closeBracket) {
            end(at);
            run = 'rest';
            depth--;
          } else if (byte !== comma && byte !== 32 && byte !== 10 && byte !== 13 && byte !== 9)
            throw unreadable();
          at++;
          continue;
        }
        at++;
        switch (byte) {
          case quote:
            inString = true;
            if (depth <= 2 && object[depth] && named[depth]) name = [];
            break;
          case openBrace:
          case openBracket: {
            const listed =
              byte === openBracket &&
              depth === 2 &&
              object[1] &&
              object[2] &&
              field[1] === 'workspace' &&
              field[2] === 'conversations' &&
              !named[2];
            depth++;
            if (depth <= 2) {
              object[depth] = byte === openBrace;
              named[depth] = byte === openBrace;
              field[depth] = undefined;
            }
            if (listed) {
              // A second list in that place is nothing this relay wrote, and which of the two a
              // reader of the text would keep is not for this one to guess.
              if (found) throw unreadable();
              // The list's own bracket stays with the rest; its conversations are taken out.
              found = true;
              end(at);
              run = 'between';
            }
            break;
          }
          case closeBrace:
          case closeBracket:
            depth--;
            if (depth < 0) throw unreadable();
            if (run === 'element' && depth === list) {
              end(at);
              const text = (element.length === 1 ? element[0] : Buffer.concat(element)).toString(
                'utf8',
              );
              element = [];
              take(JSON.parse(text));
              run = 'between';
            }
            break;
          case comma:
            if (depth <= 2 && object[depth]) named[depth] = true;
            break;
        }
      }
      end(length);
    }
    if (depth !== 0 || inString || run !== 'rest') throw unreadable();
    return JSON.parse(Buffer.concat(rest).toString('utf8'));
  } finally {
    closeSync(fd);
  }
}
