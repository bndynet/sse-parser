import type { SSEEvent, SSEParserCallbacks } from './types.js';

/**
 * WHATWG-spec-compliant SSE push parser.
 *
 * Feed arbitrary chunks of text via `feed()`.  The parser handles:
 *   - All line endings (CR, LF, CRLF)
 *   - BOM at stream start
 *   - Fields: data, event, id, retry
 *   - Multi-line `data:` (joined with LF)
 *   - Comments (`:` prefix)
 *   - Dispatch on empty line; incomplete trailing event discarded
 *
 * Reference: https://html.spec.whatwg.org/multipage/server-sent-events.html#parsing-an-event-stream
 */
export class SSEParser {
  private readonly cb: SSEParserCallbacks;

  // Per-event buffers (reset after each dispatch)
  private dataBuffer = '';
  private eventType = '';
  private lastEventId = '';

  // Line accumulation
  private lineBuffer = '';
  private bomStripped = false;
  private previousCharWasCR = false;

  constructor(callbacks: SSEParserCallbacks) {
    this.cb = callbacks;
  }

  /**
   * Push a chunk of text (may contain partial lines) into the parser.
   */
  feed(chunk: string): void {
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i];

      // Strip leading BOM (U+FEFF) once
      if (!this.bomStripped) {
        this.bomStripped = true;
        if (ch === '\uFEFF') continue;
      }

      if (ch === '\n' && this.previousCharWasCR) {
        // Second half of a CRLF pair — skip, line already processed on CR
        this.previousCharWasCR = false;
        continue;
      }

      this.previousCharWasCR = ch === '\r';

      if (ch === '\r' || ch === '\n') {
        this.processLine(this.lineBuffer);
        this.lineBuffer = '';
      } else {
        this.lineBuffer += ch;
      }
    }
  }

  /**
   * Reset all internal state so the parser can be reused on a new stream.
   */
  reset(): void {
    this.dataBuffer = '';
    this.eventType = '';
    this.lastEventId = '';
    this.lineBuffer = '';
    this.bomStripped = false;
    this.previousCharWasCR = false;
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  private processLine(line: string): void {
    // Empty line → dispatch
    if (line === '') {
      this.dispatchEvent();
      return;
    }

    // Comment
    if (line[0] === ':') {
      this.cb.onComment?.(line.slice(1));
      return;
    }

    // Field extraction
    const colonIdx = line.indexOf(':');
    let field: string;
    let value: string;

    if (colonIdx === -1) {
      // Whole line is the field name, value is empty string
      field = line;
      value = '';
    } else {
      field = line.slice(0, colonIdx);
      // Spec: if the character after the colon is a space, remove it
      value = line[colonIdx + 1] === ' '
        ? line.slice(colonIdx + 2)
        : line.slice(colonIdx + 1);
    }

    this.processField(field, value);
  }

  private processField(field: string, value: string): void {
    switch (field) {
      case 'data':
        // Append to data buffer, then append a LF
        this.dataBuffer += this.dataBuffer ? '\n' + value : value;
        break;
      case 'event':
        this.eventType = value;
        break;
      case 'id':
        // Spec: if value contains U+0000 NULL, ignore
        if (!value.includes('\0')) {
          this.lastEventId = value;
        }
        break;
      case 'retry': {
        const parsed = /^\d+$/.test(value) ? Number(value) : NaN;
        if (!Number.isNaN(parsed)) {
          // Notify via a synthetic event so the consumer can act on retry hints
          const retryEvent: SSEEvent = {
            event: '',
            data: '',
            id: this.lastEventId,
            retry: parsed,
          };
          this.cb.onEvent(retryEvent);
        }
        break;
      }
      default:
        // Unknown field — ignore per spec
        break;
    }
  }

  private dispatchEvent(): void {
    // Nothing to dispatch
    if (this.dataBuffer === '' && this.eventType === '') {
      return;
    }

    // Spec step 3: strip trailing LF from data buffer
    const data =
      this.dataBuffer.endsWith('\n')
        ? this.dataBuffer.slice(0, -1)
        : this.dataBuffer;

    const event: SSEEvent = {
      event: this.eventType || 'message',
      data,
      id: this.lastEventId,
    };

    // Reset per-event buffers (lastEventId persists across events per spec)
    this.dataBuffer = '';
    this.eventType = '';

    this.cb.onEvent(event);
  }
}
