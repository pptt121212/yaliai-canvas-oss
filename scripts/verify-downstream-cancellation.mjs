import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import {
  createDownstreamCancellation,
  isDownstreamClientDisconnectedError,
  throwIfDownstreamCancelled,
} from '../apps/api/dist/src/modules/runtime/downstreamCancellation.js';

class ResponseHarness extends EventEmitter {
  writableEnded = false;
}

const pendingResponse = new ResponseHarness();
const pending = createDownstreamCancellation({ request: { aborted: false }, response: pendingResponse });
pendingResponse.emit('close');
assert.equal(pending.signal.aborted, true, 'an unfinished response close must cancel upstream work');
assert.throws(() => throwIfDownstreamCancelled(pending.signal), isDownstreamClientDisconnectedError);
pending.dispose();

const completedResponse = new ResponseHarness();
const completed = createDownstreamCancellation({ request: { aborted: false }, response: completedResponse });
completedResponse.writableEnded = true;
completedResponse.emit('finish');
completedResponse.emit('close');
assert.equal(completed.signal.aborted, false, 'normal response completion must not be classified as cancellation');
completed.dispose();

const alreadyAborted = createDownstreamCancellation({ request: { aborted: true }, response: new ResponseHarness() });
assert.equal(alreadyAborted.signal.aborted, true, 'a request already aborted before execution must not start upstream work');
alreadyAborted.dispose();

let upstreamSawAbortedRequest = false;
const server = http.createServer((request, response) => {
  request.on('aborted', () => {
    upstreamSawAbortedRequest = true;
  });
  setTimeout(() => {
    if (!response.destroyed) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
    }
  }, 1_500);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert.ok(address && typeof address === 'object');

const disconnectingResponse = new ResponseHarness();
const disconnecting = createDownstreamCancellation({ request: { aborted: false }, response: disconnectingResponse });
const requestPromise = fetch(`http://127.0.0.1:${address.port}/slow`, { signal: disconnecting.signal });
setTimeout(() => disconnectingResponse.emit('close'), 100).unref();
await assert.rejects(requestPromise, isDownstreamClientDisconnectedError);
await new Promise((resolve) => setTimeout(resolve, 100));
assert.equal(upstreamSawAbortedRequest, true, 'downstream cancellation must abort the in-flight upstream HTTP request');
disconnecting.dispose();
await new Promise((resolve) => server.close(resolve));

let upstreamSawAbortedBody = false;
const streamingServer = http.createServer((request, response) => {
  request.on('aborted', () => {
    upstreamSawAbortedBody = true;
  });
  response.writeHead(200, { 'content-type': 'application/json' });
  response.write('{"partial":');
  setTimeout(() => {
    if (!response.destroyed) {
      response.end('true}');
    }
  }, 1_500);
});
await new Promise((resolve) => streamingServer.listen(0, '127.0.0.1', resolve));
const streamingAddress = streamingServer.address();
assert.ok(streamingAddress && typeof streamingAddress === 'object');

const streamingResponse = new ResponseHarness();
const streamingCancellation = createDownstreamCancellation({ request: { aborted: false }, response: streamingResponse });
const upstreamResponse = await fetch(`http://127.0.0.1:${streamingAddress.port}/stream`, {
  signal: streamingCancellation.signal,
});
const bodyRead = upstreamResponse.text();
setTimeout(() => streamingResponse.emit('close'), 100).unref();
await assert.rejects(bodyRead, isDownstreamClientDisconnectedError);
await new Promise((resolve) => setTimeout(resolve, 100));
assert.equal(upstreamSawAbortedBody, true, 'cancellation during upstream response-body reading must abort the socket too');
streamingCancellation.dispose();
await new Promise((resolve) => streamingServer.close(resolve));

console.log('Downstream cancellation verification passed.');
