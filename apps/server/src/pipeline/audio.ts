import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Длительность файла в секундах (ffprobe). */
export async function probeDuration(file: string): Promise<number | null> {
  try {
    const { stdout } = await exec("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
    const n = Number.parseFloat(stdout.trim());
    return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : null;
  } catch {
    return null;
  }
}

/**
 * Склеивает аудио-файлы в один m4a (AAC 48 kbps, 16 кГц, mono) — единый формат для STT.
 * Через filter_complex concat: работает даже если сегменты отличаются параметрами.
 */
export async function concatToM4a(inputs: string[], output: string): Promise<void> {
  if (inputs.length === 0) throw new Error("Нет входных файлов для склейки");
  const args: string[] = ["-y", "-hide_banner", "-loglevel", "error"];
  for (const f of inputs) args.push("-i", f);
  const filter = inputs.map((_, i) => `[${i}:a]`).join("") + `concat=n=${inputs.length}:v=0:a=1[out]`;
  args.push("-filter_complex", filter, "-map", "[out]", "-c:a", "aac", "-b:a", "48k", "-ar", "16000", "-ac", "1", "-movflags", "+faststart", output);
  await exec("ffmpeg", args, { maxBuffer: 16 * 1024 * 1024 });
}

/** Звуковая дорожка из видео-записи (mp4 из Meet) в тот же формат, что и записи с телефона. */
export async function extractAudioToM4a(input: string, output: string): Promise<void> {
  await exec("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", input, "-vn", "-c:a", "aac", "-b:a", "48k", "-ar", "16000", "-ac", "1", "-movflags", "+faststart", output], {
    maxBuffer: 16 * 1024 * 1024,
  });
}

export async function writeTemp(dir: string, name: string, data: Buffer): Promise<string> {
  const p = join(dir, name);
  await writeFile(p, data);
  return p;
}
