import SevenZip from './7zz.js';

const EXPECTED_ISO_SIZE = 4211343360;
const TARGET_DIR = 'black-monday-discs';
const TARGET_NAME = 'BlackMonday_PAL_SCES_527.58.iso';
const PROGRESS_STEP = 16 * 1024 * 1024;
const MAX_TEXT_CAPTURE = 8 * 1024 * 1024;

let phase = 'idle';
let stdoutBytes = [];
let stderrBytes = [];
let outputHandle = null;
let outputBytes = 0;
let nextProgress = PROGRESS_STEP;
let activeRequestId = null;

function captureByte(target, value) {
  if (typeof value !== 'number') return;
  if (target.length < MAX_TEXT_CAPTURE) target.push(value & 0xFF);
}

function stdoutByte(value) {
  if (phase === 'list') captureByte(stdoutBytes, value);
}

function stderrByte(value) {
  captureByte(stderrBytes, value);
}

function decode(bytes) {
  return new TextDecoder('utf-8', { fatal: false }).decode(Uint8Array.from(bytes));
}

function parseSltEntries(text) {
  const entries = [];
  let current = {};
  const flush = () => {
    if (current.Path !== undefined) entries.push(current);
    current = {};
  };
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line || line === '----------') {
      flush();
      continue;
    }
    const index = line.indexOf(' = ');
    if (index < 0) continue;
    current[line.slice(0, index)] = line.slice(index + 3);
  }
  flush();
  return entries;
}

function numericSuffix(name) {
  const match = /\.(\d{3,})$/.exec(name);
  return match ? Number(match[1]) : null;
}

function chooseArchiveEntry(files) {
  if (!files.length) throw new Error('No archive file was selected.');
  const names = files.map(file => file.name);
  const split = names.filter(name => /\.7z\.\d{3,}$/i.test(name) || /\.\d{3,}$/i.test(name));
  if (split.length) {
    const ordered = [...split].sort((a, b) => {
      const an = numericSuffix(a) ?? 0;
      const bn = numericSuffix(b) ?? 0;
      return an - bn || a.localeCompare(b);
    });
    const first = ordered.find(name => numericSuffix(name) === 1);
    if (!first) throw new Error('Split archive detected, but part .001 is missing. Select all archive parts together.');
    const suffixes = ordered.map(numericSuffix).filter(Number.isFinite);
    for (let i = 1; i <= Math.max(...suffixes); i++) {
      if (!suffixes.includes(i)) throw new Error(`Split archive part .${String(i).padStart(3, '0')} is missing. Select all parts together.`);
    }
    return first;
  }
  const single = names.find(name => /\.7z$/i.test(name));
  if (!single) throw new Error('Select the Black Monday .7z archive, or every part of its split .7z archive.');
  return single;
}

function installFastStdoutSink(sevenZip) {
  const stream = sevenZip.FS.getStream(1);
  if (!stream?.stream_ops?.write) throw new Error('7-Zip stdout stream is unavailable.');
  const originalWrite = stream.stream_ops.write;
  stream.stream_ops = { ...stream.stream_ops };
  stream.stream_ops.write = (targetStream, buffer, offset, length, position) => {
    if (phase !== 'extract') return originalWrite(targetStream, buffer, offset, length, position);
    if (!outputHandle) throw new Error('Installer output file is not open.');
    if (!length) return 0;
    const chunk = buffer.subarray(offset, offset + length);
    const written = outputHandle.write(chunk, { at: outputBytes });
    if (written !== length) throw new Error(`Short OPFS write: ${written}/${length} bytes.`);
    outputBytes += written;
    if (outputBytes >= nextProgress) {
      self.postMessage({
        type: 'progress',
        id: activeRequestId,
        processedBytes: outputBytes,
        totalBytes: EXPECTED_ISO_SIZE,
        stage: 'extract',
      });
      nextProgress = outputBytes + PROGRESS_STEP;
    }
    return written;
  };
}

async function openOutputFile() {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle(TARGET_DIR, { create: true });
  const fileHandle = await dir.getFileHandle(TARGET_NAME, { create: true });
  const access = await fileHandle.createSyncAccessHandle();
  access.truncate(0);
  return { dir, access };
}

async function removeIncomplete(dir) {
  try { await dir?.removeEntry?.(TARGET_NAME); } catch { /* best-effort cleanup */ }
}

async function extractArchive(files, id) {
  activeRequestId = id;
  const archiveName = chooseArchiveEntry(files);
  stdoutBytes = [];
  stderrBytes = [];
  outputBytes = 0;
  nextProgress = PROGRESS_STEP;
  phase = 'list';

  const sevenZip = await SevenZip({
    stdout: stdoutByte,
    stderr: stderrByte,
    locateFile: path => new URL(path, import.meta.url).href,
    noInitialRun: true,
  });

  sevenZip.FS.mkdir('/input');
  sevenZip.FS.mount(sevenZip.WORKERFS, { files }, '/input');
  installFastStdoutSink(sevenZip);

  const archivePath = `/input/${archiveName}`;
  const listExit = await sevenZip.callMain(['l', '-slt', archivePath]);
  if (listExit !== 0) {
    throw new Error(`7-Zip could not read the archive (exit ${listExit}). ${decode(stderrBytes).trim()}`.trim());
  }

  const entries = parseSltEntries(decode(stdoutBytes));
  const isoCandidates = entries.filter(entry => /\.iso$/i.test(entry.Path || ''));
  const exact = isoCandidates.find(entry => Number(entry.Size) === EXPECTED_ISO_SIZE);
  if (!exact) {
    const found = isoCandidates.map(entry => `${entry.Path} (${entry.Size || '?'} bytes)`).join(', ');
    throw new Error(found
      ? `The archive contains ISO files, but none match the verified Black Monday PAL image size (${EXPECTED_ISO_SIZE} bytes). Found: ${found}`
      : 'No .iso file was found inside the selected 7-Zip archive.');
  }

  self.postMessage({
    type: 'archive-verified',
    id,
    archiveName,
    isoPath: exact.Path,
    totalBytes: EXPECTED_ISO_SIZE,
  });

  const { dir, access } = await openOutputFile();
  outputHandle = access;
  stderrBytes = [];
  phase = 'extract';
  try {
    // -so streams the selected ISO to stdout. We replace fd 1's stream writer
    // above, so 7-Zip writes each native output chunk straight into OPFS rather
    // than materialising a 4.21 GB file in the WASM heap. Input is mounted via
    // WORKERFS, so the .7z itself is read from the iPhone File object on demand.
    const exitCode = await sevenZip.callMain([
      'e', archivePath, exact.Path, '-so', '-y', '-bsp0', '-bse2',
    ]);
    outputHandle.flush();
    const actualSize = outputHandle.getSize();
    outputHandle.close();
    outputHandle = null;
    phase = 'idle';

    if (exitCode !== 0) {
      await removeIncomplete(dir);
      throw new Error(`7-Zip extraction failed (exit ${exitCode}). ${decode(stderrBytes).trim()}`.trim());
    }
    if (outputBytes !== EXPECTED_ISO_SIZE || actualSize !== EXPECTED_ISO_SIZE) {
      await removeIncomplete(dir);
      throw new Error(`Extraction produced ${actualSize} bytes; expected ${EXPECTED_ISO_SIZE}.`);
    }

    self.postMessage({
      type: 'progress', id, processedBytes: outputBytes, totalBytes: EXPECTED_ISO_SIZE, stage: 'extract',
    });
    self.postMessage({
      type: 'done', id, targetName: TARGET_NAME, size: actualSize, archiveName, isoPath: exact.Path,
    });
  } catch (error) {
    try { outputHandle?.close?.(); } catch { /* ignore cleanup */ }
    outputHandle = null;
    phase = 'idle';
    await removeIncomplete(dir);
    throw error;
  }
}

self.onmessage = async event => {
  const msg = event.data;
  if (!msg || msg.type !== 'install') return;
  const id = msg.id || `${Date.now()}`;
  try {
    const files = Array.from(msg.files || []);
    await extractArchive(files, id);
  } catch (error) {
    self.postMessage({
      type: 'error',
      id,
      message: error?.message || String(error),
      stack: error?.stack || null,
    });
  }
};
