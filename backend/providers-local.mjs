import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createProviders as createPortableProviders } from './providers.mjs';

const runFile = promisify(execFile);

async function speak(input, voiceName) {
  const folder = await mkdtemp(join(tmpdir(), 'yuban-voice-'));
  try {
    const inputPath = join(folder, 'input.txt');
    const audioPath = join(folder, 'voice.wav');
    await writeFile(inputPath, input, 'utf8');
    await runFile('/usr/bin/say', [
      '-v', voiceName, '-r', '175', '-o', audioPath, '--file-format=WAVE', '--data-format=LEI16@22050', '-f', inputPath,
    ], { timeout: 12000 });
    const bytes = await readFile(audioPath);
    if (bytes.length <= 44 || bytes.toString('ascii', 0, 4) !== 'RIFF') throw new Error('系统语音没有生成有效音频');
    return { bytes, contentType: 'audio/wav', filename: 'yuban-voice.wav' };
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

export function createProviders(env = process.env, options = {}) {
  if (process.platform !== 'darwin' || !existsSync('/usr/bin/say') || env.VOICE_MACOS === '0') {
    return createPortableProviders(env, options);
  }
  return createPortableProviders(env, {
    ...options,
    localAudio(input) {
      const defaultVoice = /\p{Script=Han}/u.test(input) ? 'Tingting' : 'Samantha';
      return speak(input, env.VOICE_MACOS_NAME?.trim() || defaultVoice);
    },
  });
}
