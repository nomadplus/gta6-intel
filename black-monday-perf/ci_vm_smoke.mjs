import { chromium, webkit } from 'playwright';

const url = process.env.BM_SELFTEST_URL || 'http://127.0.0.1:4173/black-monday/?selftest=1&noautoboot=1';
const timeoutMs = Number(process.env.BM_SELFTEST_TIMEOUT_MS || 45000);

const engines = [
  {
    name: 'chromium',
    launcher: chromium,
    required: true,
    launchOptions: {
      headless: true,
      args: ['--use-angle=swiftshader-webgl', '--enable-unsafe-swiftshader'],
    },
  },
  { name: 'webkit', launcher: webkit, required: false, launchOptions: { headless: true } },
];

let hardFailures = 0;

for (const engine of engines) {
  console.log(`\n=== BLACK_MONDAY_WEB VM self-test: ${engine.name} ===`);
  let browser;
  try {
    browser = await engine.launcher.launch(engine.launchOptions);
    const context = await browser.newContext();
    const page = await context.newPage();
    const consoleLines = [];
    page.on('console', msg => {
      const line = `[${engine.name} console:${msg.type()}] ${msg.text()}`;
      consoleLines.push(line);
      console.log(line);
    });
    page.on('pageerror', error => {
      const line = `[${engine.name} pageerror] ${error?.stack || error}`;
      consoleLines.push(line);
      console.error(line);
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    const probe = await page.evaluate(() => ({
      crossOriginIsolated: globalThis.crossOriginIsolated === true,
      sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
      webAssembly: typeof WebAssembly === 'object',
      webgl2: Boolean(document.createElement('canvas').getContext('webgl2')),
      userAgent: navigator.userAgent,
    }));
    console.log(`[${engine.name}] prerequisites=${JSON.stringify(probe)}`);

    // Play!'s browser build requires shared-memory WASM and WebGL2. Desktop
    // Playwright WebKit builds can lack one of those even when iOS Safari has it,
    // so WebKit is a conditional gate. Chromium is always a hard gate.
    const eligible = probe.crossOriginIsolated && probe.sharedArrayBuffer && probe.webAssembly && probe.webgl2;
    if (!eligible) {
      const text = `${engine.name} runner lacks Play! prerequisites; self-test not representative.`;
      if (engine.required) throw new Error(text);
      console.warn(`[${engine.name}] SKIP: ${text}`);
      await context.close();
      await browser.close();
      continue;
    }

    await page.waitForFunction(() => {
      const state = window.__blackMondaySelfTest?.state;
      return state === 'passed' || state === 'failed';
    }, null, { timeout: timeoutMs });

    const result = await page.evaluate(() => ({
      selfTest: window.__blackMondaySelfTest ?? null,
      status: document.getElementById('status')?.textContent ?? null,
      probe: document.getElementById('probe')?.textContent ?? null,
    }));
    console.log(`[${engine.name}] result=${JSON.stringify(result, null, 2)}`);

    if (result.selfTest?.state !== 'passed') {
      throw new Error(`${engine.name} initVm smoke test failed: ${result.selfTest?.error || result.status || 'unknown failure'}`);
    }

    console.log(`[${engine.name}] PASS: Play! initVm returned in ${Math.round(result.selfTest.elapsedMs || 0)} ms.`);
    await context.close();
  } catch (error) {
    console.error(`[${engine.name}] FAIL: ${error?.stack || error}`);
    if (engine.required) hardFailures += 1;
    else console.warn(`[${engine.name}] non-blocking WebKit diagnostic failure recorded.`);
  } finally {
    await browser?.close().catch(() => {});
  }
}

if (hardFailures > 0) {
  console.error(`BLACK_MONDAY_WEB VM self-test failed with ${hardFailures} hard failure(s).`);
  process.exit(1);
}

console.log('\nBLACK_MONDAY_WEB automated VM smoke test passed.');
