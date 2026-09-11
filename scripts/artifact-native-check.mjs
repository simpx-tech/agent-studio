import assert from 'node:assert/strict';

// Attach only to the isolated preview target, never another app or browser session.
export async function checkNativeArtifact(port) {
  let target;
  const deadline = Date.now() + 15000;
  while (!target && Date.now() < deadline) {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    target = targets.find(
      (t) => t.type === 'iframe' && t.url === 'http://studio-artifact.localhost/',
    );
    if (!target) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert(target, 'Native artifact frame is unavailable');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  try {
    const result = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Artifact check timed out')), 15000);
      socket.onmessage = ({ data }) => {
        const value = JSON.parse(data);
        if (value.id !== 1) return;
        clearTimeout(timeout);
        if (value.error || value.result.exceptionDetails)
          reject(new Error('Artifact script failed'));
        else resolve(value.result.result.value);
      };
      socket.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: {
            awaitPromise: true,
            returnByValue: true,
            expression: `(async()=>{
        const deadline = Date.now() + 10000;
        while (!document.querySelector('#count') && Date.now() < deadline) await new Promise(resolve=>setTimeout(resolve,50));
        const button = [...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Add one');
        if (!button || !document.querySelector('#count')) throw Error('Counter is not rendered');
        const before = Number(document.querySelector('#count').textContent); button.click();
        let parentBlocked=false, storageBlocked=false, networkBlocked=false;
        try { void parent.document.body; } catch { parentBlocked=true; }
        try { localStorage.getItem('fixture'); } catch { storageBlocked=true; }
        try { await fetch('https://example.com/artifact-network-fixture'); } catch { networkBlocked=true; }
        const bridgeHelpersPresent = typeof window.__TAURI_INTERNALS__ !== 'undefined';
        const probe = async (command) => !bridgeHelpersPresent || await Promise.race([
          window.__TAURI_INTERNALS__.invoke(command).then(()=>false,()=>true),
          new Promise(resolve=>setTimeout(()=>resolve(true),1500))
        ]);
        const nativeIpcBlocked = await probe('plugin:app|identifier') && await probe('get_installation');
        return {before, after:Number(document.querySelector('#count').textContent), parentBlocked,storageBlocked,networkBlocked,bridgeHelpersPresent,nativeIpcBlocked};
      })()`,
          },
        }),
      );
    });
    assert.equal(result.after, result.before + 1);
    for (const key of ['parentBlocked', 'storageBlocked', 'networkBlocked', 'nativeIpcBlocked'])
      assert.equal(result[key], true, key);
    return result;
  } finally {
    socket.close();
  }
}
