import type {Logger} from './logger';
import {resolver} from './resolver';
import {sleep} from './sleep';

export const DEBOUNCE_DELAY_MS = 10;

export const MIN_DELAY_MS = 30;
export const MAX_DELAY_MS = 60_000;

type SendRecord = {duration: number; ok: boolean};

export interface ConnectionLoopDelegate extends Logger {
  invokeSend(): Promise<boolean>;
  debounceDelay: number;
  // If null, no watchdog timer is used.
  watchdogTimer: number | null;
  maxConnections: number;
  maxDelayMs: number;
  minDelayMs: number;
}

export class ConnectionLoop {
  // ConnectionLoop runs a loop sending network requests (either pushes or
  // pulls) to the server. Our goal, generally, is to send requests as fast as
  // we can, but to adjust in case of slowness, network errors, etc. We will
  // send requests in parallel if the server supports it. We also debounce
  // pushes since they frequently happen in series very near to one another
  // (e.g., during drag'n drops).
  //
  // The loop flows through the following states forever, until it is closed:
  //
  // Pending: Wait for event or watchdog
  //          |
  //          v
  // Debounce: Wait for more events (we debounce pushes)
  //          |
  //          v
  // Wait for available connection (we limit number of parallel requests
  // allowed)
  //          |
  //          v
  // Wait to send (if requests are taking too long, we will slow down)
  //          |
  //          v
  // Send (asynchronously, wrt the loop)
  //          |
  //          v
  // Back to the pending!

  // Controls whether the next iteration of the loop will wait at the pending
  // state.
  private _pendingResolver = resolver<void>();

  private readonly _delegate: ConnectionLoopDelegate;
  private _closed = false;

  constructor(delegate: ConnectionLoopDelegate) {
    this._delegate = delegate;
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    this.run();
  }

  close(): void {
    this._closed = true;
  }

  send(): void {
    this._delegate.debug?.('send');
    this._pendingResolver.resolve();
  }

  async run(): Promise<void> {
    const sendRecords: SendRecord[] = [];

    let recoverResolver = resolver();
    let lastSendTime;

    // The number of active connections.
    let counter = 0;
    const delegate = this._delegate;
    const {debug} = delegate;
    let delay = 0;

    debug?.('Starting connection loop');

    while (!this._closed) {
      debug?.(
        didLastSendRequestFail(sendRecords)
          ? 'Last request failed. Trying again'
          : 'Waiting for a send',
      );

      // Wait until send is called or until the watchdog timer fires.
      const races = [this._pendingResolver.promise];
      const t = delegate.watchdogTimer;
      if (t !== null) {
        races.push(sleep(t));
      }
      await Promise.race(races);
      if (this._closed) break;

      debug?.('Waiting for debounce');
      await sleep(delegate.debounceDelay);
      if (this._closed) break;
      debug?.('debounced');

      // This resolver is used to wait for incoming push calls.
      this._pendingResolver = resolver();

      if (counter >= delegate.maxConnections) {
        debug?.('Too many request in flight. Waiting until one finishes...');
        await this._waitUntilAvailableConnection();
        if (this._closed) break;
        debug?.('...finished');
      }

      // We need to delay the next request even if there are no active requests
      // in case of error.
      if (counter > 0 || didLastSendRequestFail(sendRecords)) {
        delay = computeDelayAndUpdateDurations(delay, delegate, sendRecords);
        debug?.(
          didLastSendRequestFail(sendRecords)
            ? 'Last connection errored. Sleeping for'
            : 'More than one outstanding connection (' +
                counter +
                '). Sleeping for',
          delay,
          'ms',
        );
      } else {
        // We set this to 0 here in case minDelayMs is mutated to a lower value
        // than the old delay so that we still get minDelayMs. This can happen
        // if we get an error during a run where minDelayMs is larger than the
        // current value of minDelayMs.
        delay = 0;
      }

      const clampedDelay = Math.min(
        delegate.maxDelayMs,
        Math.max(delegate.minDelayMs, delay),
      );
      if (lastSendTime !== undefined) {
        const timeSinceLastSend = Date.now() - lastSendTime;
        if (clampedDelay > timeSinceLastSend) {
          await Promise.race([
            sleep(clampedDelay - timeSinceLastSend),
            recoverResolver.promise,
          ]);
          if (this._closed) break;
        }
      }

      counter++;
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      (async () => {
        const start = Date.now();
        let ok: boolean;
        try {
          lastSendTime = start;
          debug?.('Sending request');
          ok = await delegate.invokeSend();
          debug?.('Send returned', ok);
        } catch (e) {
          debug?.('Send failed', e);
          ok = false;
        }
        if (this._closed) {
          debug?.('Closed after invokeSend');
          return;
        }
        debug?.('Request done', {duration: Date.now() - start, ok});
        sendRecords.push({duration: Date.now() - start, ok});
        if (recovered(sendRecords)) {
          recoverResolver.resolve();
          recoverResolver = resolver();
        }
        counter--;
        this._connectionAvailable();
        if (!ok) {
          // Keep trying
          this._pendingResolver.resolve();
        }
      })();
    }
  }

  private _waitingConnectionResolve: (() => void) | undefined = undefined;

  private _connectionAvailable() {
    if (this._waitingConnectionResolve) {
      const resolve = this._waitingConnectionResolve;
      this._waitingConnectionResolve = undefined;
      resolve();
    }
  }

  private _waitUntilAvailableConnection() {
    const {promise, resolve} = resolver();
    this._waitingConnectionResolve = resolve;
    return promise;
  }
}

// Number of connections to remember when computing the new delay.
const CONNECTION_MEMORY_COUNT = 9;

// Computes a new delay based on the previous requests. We use the median of the
// previous successfull request divided by `maxConnections`. When we get errors
// we do exponential backoff. As soon as we recover from an error we reset back
// to delegate.minDelayMs.
function computeDelayAndUpdateDurations(
  delay: number,
  delegate: ConnectionLoopDelegate,
  sendRecords: SendRecord[],
): number {
  const {length} = sendRecords;
  if (length === 0) {
    return delay;
  }

  const {ok} = sendRecords[sendRecords.length - 1];
  const {maxConnections, minDelayMs} = delegate;

  if (!ok) {
    return delay === 0 ? minDelayMs : delay * 2;
  }

  if (length > 1) {
    // length > 1
    const previous: SendRecord = sendRecords[sendRecords.length - 2];

    // Prune
    while (sendRecords.length > CONNECTION_MEMORY_COUNT) {
      sendRecords.shift();
    }

    if (ok && !previous.ok) {
      // Recovered
      return minDelayMs;
    }
  }

  const med = median(
    sendRecords.filter(({ok}) => ok).map(({duration}) => duration),
  );

  return (med / maxConnections) | 0;
}

function median(values: number[]) {
  values.sort();
  const {length} = values;
  const half = length >> 1;
  if (length % 2 === 1) {
    return values[half];
  }
  return (values[half - 1] + values[half]) / 2;
}

function didLastSendRequestFail(sendRecords: SendRecord[]) {
  return sendRecords.length > 0 && !sendRecords[sendRecords.length - 1].ok;
}

function recovered(sendRecords: SendRecord[]) {
  return (
    sendRecords.length > 1 &&
    !sendRecords[sendRecords.length - 2].ok &&
    sendRecords[sendRecords.length - 1].ok
  );
}
