import { createReadStream } from 'fs';
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'fs/promises';
import { extname, join } from 'path';

const directory = join(process.cwd(), 'data');

export type SoundSlot = 'alarm-sound' | 'recovery-sound';

const extensions = new Map<string, string>([
  ['audio/mpeg', '.mp3'],
  ['audio/mp3', '.mp3'],
  ['audio/wav', '.wav'],
  ['audio/x-wav', '.wav'],
  ['audio/wave', '.wav'],
  ['audio/ogg', '.ogg'],
  ['audio/webm', '.webm'],
  ['audio/mp4', '.m4a'],
  ['audio/aac', '.aac'],
  ['audio/x-m4a', '.m4a'],
]);

const filenameExtensions = new Set(['.mp3', '.wav', '.ogg', '.webm', '.m4a', '.aac']);

export function alarmExtension(mime: string, originalName: string) {
  const fromMime = extensions.get(mime.toLowerCase());
  if (fromMime) return fromMime;
  const fromName = extname(originalName).toLowerCase();
  return filenameExtensions.has(fromName) ? fromName : null;
}

export function cleanSoundName(name: string) {
  const base = name.split(/[/\\]/).pop() ?? 'alarm';
  const cleaned = base.replace(/[^\w.\- ()]/g, '').trim();
  return (cleaned || 'alarm').slice(0, 120);
}

export async function saveAlarmSound(buffer: Buffer, extension: string, slot: SoundSlot = 'alarm-sound') {
  await mkdir(directory, { recursive: true });
  await removeAlarmSound(slot);
  const filename = `${slot}${extension}`;
  const temporary = join(directory, `${filename}.tmp`);
  await writeFile(temporary, buffer);
  await rename(temporary, join(directory, filename));
  return filename;
}

export async function removeAlarmSound(slot: SoundSlot = 'alarm-sound') {
  const names = await readdir(directory).catch(() => [] as string[]);
  await Promise.all(
    names
      .filter((name) => name.startsWith(slot))
      .map((name) => unlink(join(directory, name)).catch(() => undefined)),
  );
}

async function alarmFile(slot: SoundSlot) {
  const names = await readdir(directory).catch(() => [] as string[]);
  const filename = names.find((name) => name.startsWith(slot) && !name.endsWith('.tmp'));
  if (!filename) return null;
  const extension = filename.slice(slot.length);
  const mime = [...extensions.entries()].find(([, ext]) => ext === extension)?.[0] ?? 'application/octet-stream';
  return { path: join(directory, filename), mime };
}

export async function hasAlarmSound(slot: SoundSlot = 'alarm-sound') {
  return Boolean(await alarmFile(slot));
}

export async function openAlarmSound(slot: SoundSlot = 'alarm-sound') {
  const file = await alarmFile(slot);
  if (!file) return null;
  return { ...file, stream: createReadStream(file.path) };
}

const soundFile = /^(alarm-sound|recovery-sound)\.(mp3|wav|ogg|webm|m4a|aac)$/;

export async function listAlarmSoundNames() {
  const names = await readdir(directory).catch(() => [] as string[]);
  return names.filter((name) => soundFile.test(name));
}

export async function readAlarmSounds() {
  const names = await listAlarmSoundNames();
  const files: { name: string; data: Buffer }[] = [];
  for (const name of names) {
    files.push({ name, data: await readFile(join(directory, name)) });
  }
  return files;
}

export async function replaceAlarmSounds(files: { name: string; data: Buffer }[]) {
  for (const file of files) {
    if (!soundFile.test(file.name)) throw new Error('Nama file nada tidak valid');
  }
  await removeAlarmSound('alarm-sound');
  await removeAlarmSound('recovery-sound');
  if (!files.length) return;
  await mkdir(directory, { recursive: true });
  for (const file of files) {
    const temporary = join(directory, `${file.name}.tmp`);
    await writeFile(temporary, file.data);
    await rename(temporary, join(directory, file.name));
  }
}
