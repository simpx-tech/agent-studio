// Page-scoped CDP avoids WebView2 shared-worker attachment errors in browser-wide clients.
import assert from 'node:assert/strict';

export async function nativePage(port) {
  const inventory = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = [inventory]
    .flat()
    .find(
      (target) =>
        target.type === 'page' &&
        (target.url.includes('1420') || target.url.startsWith('http://tauri.localhost/')),
    );
  assert(target, 'Native app page is not ready.');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  let next = 0;
  const pending = new Map();
  const errors = [];
  socket.onclose = () => {
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(new Error('Native page closed.'));
    }
    pending.clear();
  };
  socket.onmessage = ({ data }) => {
    const response = JSON.parse(data);
    if (response.method === 'Runtime.exceptionThrown')
      errors.push(response.params.exceptionDetails.text);
    const request = pending.get(response.id);
    if (!request) return;
    pending.delete(response.id);
    clearTimeout(request.timeout);
    if (response.error) request.reject(new Error(response.error.message));
    else request.resolve(response.result);
  };
  const cdp = (method, params = {}, timeoutMs = 30000) =>
    new Promise((resolve, reject) => {
      const id = ++next;
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timeout });
      socket.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (fn, ...args) => {
    const response = await cdp(
      'Runtime.evaluate',
      {
        expression: `(${fn.toString()})(...${JSON.stringify(args)})`,
        awaitPromise: true,
        returnByValue: true,
      },
      120000,
    );
    if (response.exceptionDetails)
      throw new Error(
        response.exceptionDetails.exception?.description ?? response.exceptionDetails.text,
      );
    return response.result.value;
  };
  const waitFor = async (fn, ...args) => {
    const deadline = Date.now() + 30000;
    while (!(await evaluate(fn, ...args))) {
      assert(Date.now() < deadline, `UI condition timed out: ${fn}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  const click = (selector) =>
    evaluate((selector) => {
      const control = document.querySelector(selector);
      if (!control || control.disabled) throw new Error(`Control unavailable: ${selector}`);
      control.click();
    }, selector);
  const button = (name) =>
    evaluate((name) => {
      const control = [...document.querySelectorAll('button')].find(
        (el) => (el.getAttribute('aria-label') ?? el.innerText).trim() === name,
      );
      if (!control || control.disabled) throw new Error(`Button unavailable: ${name}`);
      control.click();
    }, name);
  await cdp('Runtime.enable');
  return {
    cdp,
    evaluate,
    waitFor,
    click,
    button,
    errors,
    close: () => socket.close(),
    invoke: (command, args) =>
      evaluate((command, args) => window.__TAURI_INTERNALS__.invoke(command, args), command, args),
  };
}
