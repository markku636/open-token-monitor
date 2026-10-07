'use strict';

// Moves records from the hub's memory into the database without ever holding a
// device's HTTP request open for it.
//
// One entry per device: a newer record replaces the one still waiting, the same
// "newest wins" shape as the uploader's own orderedSink. The diff for a write is
// always taken against the last record that actually reached the database
// (`base`), not against the record that happened to precede it, so a record that
// was replaced while the database was down cannot take its changes with it.

const { captureRows } = require('./capture');

// Errors that say the data itself is unacceptable to the database. Retrying
// them can never succeed, and retrying forever would wedge the queue behind one
// bad record: SQLSTATE class 22 (data exception) and 23 (integrity constraint
// violation), which PostgreSQL drivers report as `code`. Everything else (a
// lost connection, a lock timeout, a serialization failure) is retried.
function isPermanentStoreError(error) {
  const state = String(error?.code || '');
  return /^(22|23)[0-9A-Z]{3}$/.test(state);
}

function createPersistQueue({ store, logger = console, now = () => Date.now(), minRetryMs = 1000, maxRetryMs = 30000 } = {}) {
  const base = new Map();
  const pending = new Map();
  const idleWaiters = new Set();
  let running = null;
  let timer = null;
  let retryMs = 0;
  let stopped = false;
  const state = {
    writes: 0,
    stale: 0,
    failures: 0,
    dropped: 0,
    lastWriteAt: null,
    lastError: null,
    lastErrorAt: null
  };

  function settleIdle() {
    if (running || pending.size || timer) return;
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
  }

  function schedule(delayMs) {
    if (stopped || running || timer) return;
    timer = setTimeout(() => {
      timer = null;
      startDrain();
    }, delayMs);
    // Only a retry backoff must not hold a stopping process open; an immediate
    // drain keeps it alive so whenIdle() always settles.
    if (delayMs) timer.unref?.();
  }

  function startDrain() {
    if (running) return running;
    running = drain()
      .catch((error) => (logger.error || console.error)(`[persistence] queue crashed: ${error.stack || error.message}`))
      .finally(() => {
        running = null;
        settleIdle();
      });
    return running;
  }

  function noteError(error) {
    state.lastError = error.message;
    state.lastErrorAt = new Date(now()).toISOString();
  }

  // Writes one device's newest record. Returns false when the database is
  // unavailable and the queue should back off; the entry is then put back,
  // folded into anything newer that arrived meanwhile.
  async function writeOne(deviceId, entry) {
    let capture;
    try {
      capture = captureRows(base.get(deviceId), entry.record, { hadHistory: entry.hadHistory, meta: entry.meta });
    } catch (error) {
      // A record that cannot be turned into rows never will be; retrying it
      // would wedge the queue behind it.
      state.dropped += 1;
      (logger.warn || console.warn)(`[persistence] skipped device ${deviceId}: ${error.message}`);
      return true;
    }
    try {
      const outcome = await store.writeCapture(capture);
      base.set(deviceId, entry.record);
      if (outcome === 'stale') state.stale += 1;
      else state.writes += 1;
      state.lastWriteAt = new Date(now()).toISOString();
      retryMs = 0;
      return true;
    } catch (error) {
      noteError(error);
      if (isPermanentStoreError(error)) {
        state.dropped += 1;
        (logger.error || console.error)(`[persistence] dropped a record of device ${deviceId} the database refuses: ${error.message}`);
        return true;
      }
      const newer = pending.get(deviceId);
      pending.delete(deviceId);
      pending.set(deviceId, newer ? { ...newer, hadHistory: newer.hadHistory || entry.hadHistory } : entry);
      state.failures += 1;
      retryMs = Math.min(maxRetryMs, retryMs ? retryMs * 2 : minRetryMs);
      (logger.warn || console.warn)(`[persistence] write failed (${pending.size} device(s) waiting, retry in ${retryMs} ms): ${error.message}`);
      return false;
    }
  }

  async function drain() {
    while (pending.size && !stopped) {
      const [deviceId, entry] = pending.entries().next().value;
      pending.delete(deviceId);
      if (!(await writeOne(deviceId, entry))) {
        // Clear the in-flight marker first so the retry can be scheduled;
        // startDrain() clears it again when this call settles.
        running = null;
        schedule(retryMs);
        return;
      }
    }
  }

  return {
    // Records already in the database when the hub starts (rehydration).
    seed(records) {
      for (const record of records) {
        if (record?.deviceId) base.set(String(record.deviceId), record);
      }
    },
    enqueue(record, { hadHistory = false, meta } = {}) {
      if (stopped || !record?.deviceId) return;
      const deviceId = String(record.deviceId);
      const previous = pending.get(deviceId);
      pending.set(deviceId, {
        record,
        hadHistory: Boolean(hadHistory || previous?.hadHistory),
        meta: meta || previous?.meta
      });
      if (!retryMs) schedule(0);
    },
    // A deleted device starts from nothing if it ever reports again, exactly as
    // upstream's in-memory store does.
    forget(deviceId) {
      base.delete(String(deviceId));
      pending.delete(String(deviceId));
    },
    whenIdle() {
      if (!running && !pending.size && !timer) return Promise.resolve();
      return new Promise((resolve) => idleWaiters.add(resolve));
    },
    status() {
      return { ...state, queueDepth: pending.size, retrying: retryMs > 0, retryMs };
    },
    // Shutdown: wait for a write in progress, then make one last pass over
    // everything still waiting, so the next start rehydrates the newest state.
    // A database that is down just fails that pass quickly.
    async stop() {
      if (timer) clearTimeout(timer);
      timer = null;
      if (running) await running;
      if (pending.size) {
        retryMs = 0;
        await startDrain();
      }
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      settleIdle();
    }
  };
}

// Audit rows are written in batches: one INSERT a second instead of one per
// upload. Bounded, so an outage costs the oldest audit rows, never memory.
function createEventBuffer({ store, logger = console, flushMs = 1000, maxBuffered = 20000 } = {}) {
  let buffer = [];
  let flushing = false;
  let dropped = 0;
  const timer = setInterval(() => { flush().catch(() => {}); }, flushMs);
  timer.unref?.();

  async function flush() {
    if (flushing || !buffer.length) return;
    flushing = true;
    const batch = buffer;
    buffer = [];
    try {
      await store.insertIngestEvents(batch);
    } catch (error) {
      buffer = batch.concat(buffer);
      if (buffer.length > maxBuffered) {
        dropped += buffer.length - maxBuffered;
        buffer = buffer.slice(buffer.length - maxBuffered);
      }
      (logger.warn || console.warn)(`[persistence] audit write failed (${buffer.length} buffered): ${error.message}`);
    } finally {
      flushing = false;
    }
  }

  return {
    push(event) {
      buffer.push(event);
      if (buffer.length > maxBuffered) {
        dropped += buffer.length - maxBuffered;
        buffer = buffer.slice(buffer.length - maxBuffered);
      }
    },
    flush,
    status() {
      return { buffered: buffer.length, dropped };
    },
    async stop() {
      clearInterval(timer);
      await flush().catch(() => {});
    }
  };
}

module.exports = { createEventBuffer, createPersistQueue, isPermanentStoreError };
