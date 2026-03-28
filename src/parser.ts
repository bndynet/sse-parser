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
  private hasData = false;
  private eventType = '';
  private lastEventId = '';
  private pendingRetry?: number;

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
    this.hasData = false;
    this.eventType = '';
    this.lastEventId = '';
    this.pendingRetry = undefined;
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
        // Spec: append the value then a single LF after every data line.
        // The final trailing LF is stripped at dispatch time.
        this.dataBuffer += value + '\n';
        this.hasData = true;
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
          // Record the reconnection-time hint; surfaced via `onRetry` and
          // attached to the next dispatched event's `retry` field.
          this.pendingRetry = parsed;
          this.cb.onRetry?.(parsed);
        }
        break;
      }
      default:
        // Unknown field — ignore per spec
        break;
    }
  }

  private dispatchEvent(): void {
    // Nothing to dispatch (no data lines and no explicit event type)
    if (!this.hasData && this.eventType === '') {
      return;
    }

    // Spec step 3: strip the single trailing LF from the data buffer
    const data =
      this.dataBuffer.endsWith('\n')
        ? this.dataBuffer.slice(0, -1)
        : this.dataBuffer;

    const event: SSEEvent = {
      event: this.eventType || 'message',
      data,
      id: this.lastEventId,
    };

    if (this.pendingRetry !== undefined) {
      event.retry = this.pendingRetry;
      this.pendingRetry = undefined;
    }

    // Reset per-event buffers (lastEventId persists across events per spec)
    this.dataBuffer = '';
    this.hasData = false;
    this.eventType = '';

    this.cb.onEvent(event);
  }
}
