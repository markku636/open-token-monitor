'use strict';

// Puts a handler in front of the request listeners a hub's server already has.
//
// http.createServer(listener) registers its argument on 'request', so upstream's
// handler is reachable through the public listener list without a private
// reference. It is taken off and re-dispatched from our listener because the
// overlay has to answer some requests *before* the secret gate inside upstream's
// handleRequest(); a prepended listener could only run beside it, and both would
// then write a response. Layers stack: each call wraps whatever the server had.
//
// The handler gets (req, res, forward). It either answers the request itself or
// calls forward(req, res) to pass it to the layer underneath. It may be async.

const { upstream } = require('../upstream');
const { sendJson } = require(upstream('src/shared/http'));

function wrapRequestListeners(server, handler, { logger = console } = {}) {
  const inner = server.listeners('request');
  if (inner.length === 0) {
    throw new Error('upstream createHub() no longer registers a request listener; hub/router.js needs updating');
  }
  server.removeAllListeners('request');
  const forward = (req, res) => {
    for (const listener of inner) listener.call(server, req, res);
  };
  const fail = (res, error) => {
    (logger.error || console.error)(error);
    if (res.headersSent) {
      try { res.end(); } catch (_) {}
      return;
    }
    sendJson(res, 500, { error: 'internal_error', message: error.message });
  };
  server.on('request', (req, res) => {
    let result;
    try {
      result = handler(req, res, forward);
    } catch (error) {
      fail(res, error);
      return;
    }
    if (result && typeof result.then === 'function') result.catch((error) => fail(res, error));
  });
}

module.exports = { wrapRequestListeners };
