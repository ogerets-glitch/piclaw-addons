import { expect, test, spyOn } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as childProcess from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getExecutableCatalog, runDelegateProcess } from './delegate.ts';

// Linux /proc distinguishes an exited zombie from a runnable survivor and lets
// failure cleanup verify identity before signaling a PID (never a saved PGID).
function identity(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
    return stat[0] === 'Z' ? null : stat[19];
  } catch { return null; }
}
async function until(check: () => boolean, ms: number) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await Bun.sleep(10);
  expect(check()).toBe(true);
}

for (const path of ['discovery', 'execution'] as const) {
  for (const mode of ['timeout', 'abort'] as const) {
    (process.platform === 'linux' ? test : test.skip)(`${path} ${mode}: TERM-exiting parent cannot strand TERM-ignoring descendant`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'delegate-descendant-'));
      const ready = join(root, 'ready'), exited = join(root, 'parent-term');
      const descendant = join(root, 'descendant.ts'), parent = join(root, 'parent.ts');
      const controller = new AbortController();
      let pending: Promise<unknown> | undefined;
      let pid = 0, start: string | null = null;
      try {
        writeFileSync(descendant, `import{writeFileSync}from'node:fs';process.on('SIGTERM',()=>{});writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},100);`);
        writeFileSync(parent, `import{spawn}from'node:child_process';import{writeFileSync}from'node:fs';process.on('SIGTERM',()=>{writeFileSync(${JSON.stringify(exited)},'yes');process.exit(0)});spawn(process.execPath,[${JSON.stringify(descendant)}],{stdio:'ignore'});setInterval(()=>{},100);`);
        const cli = { command: process.execPath, argsPrefix: [parent], label: 'descendant-fixture' };
        pending = (path === 'discovery'
          ? getExecutableCatalog(true, mode === 'timeout' ? 500 : 4000, controller.signal, cli)
          : runDelegateProcess([], '', mode === 'timeout' ? 500 : 4000, controller.signal, undefined, cli))
          .then(() => ({ error: '' }), error => ({ error: String(error.message) }));
        await until(() => existsSync(ready), 1500);
        pid = Number(readFileSync(ready, 'utf8')); start = identity(pid);
        expect(start).not.toBeNull();
        if (mode === 'abort') controller.abort();
        expect((await pending as { error: string }).error).toMatch(mode === 'abort' ? /aborted/i : /timed out/i);
        await until(() => existsSync(exited), 1000);
        // The descendant really ignored TERM; it dies only at group escalation.
        expect(identity(pid)).toBe(start);
        await until(() => identity(pid) !== start, 3500);
      } finally {
        controller.abort();
        await pending;
        if (!pid && existsSync(ready)) pid = Number(readFileSync(ready, 'utf8'));
        const current = pid ? identity(pid) : null;
        if (current && (!start || current === start)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
        // Let the owned anchor finish even when an assertion failed.
        await Bun.sleep(2200);
        rmSync(root, { recursive: true, force: true });
      }
    }, 12000);
  }
}

for (const path of ['discovery', 'execution'] as const) {
  test(`${path}: already aborted never spawns`, async () => {
    const controller = new AbortController();
    controller.abort();
    const spawn = spyOn(childProcess, 'spawn');
    try {
      const cli = { command: process.execPath, argsPrefix: [], label: 'preabort' };
      if (path === 'discovery') {
        await expect(getExecutableCatalog(true, 1000, controller.signal, cli)).rejects.toThrow('Aborted');
      } else {
        await expect(runDelegateProcess([], '', 1000, controller.signal, undefined, cli)).rejects.toMatchObject({ name: 'AbortError' });
      }
      expect(spawn).not.toHaveBeenCalled();
    } finally { spawn.mockRestore(); }
  });
  for (const code of [0, 7]) {
    (process.platform === 'linux' ? test : test.skip)(`${path} natural CLI exit ${code}: cleans TERM-ignoring descendant and preserves status`, async () => {
      const root = mkdtempSync(join(tmpdir(), "delegate natural 'quoted' $-"));
      const ready = join(root, 'ready');
      const descendant = join(root, 'descendant.ts'), parent = join(root, 'parent.ts');
      let pid = 0, start: string | null = null;
      let pending: Promise<any> | undefined;
      try {
        writeFileSync(descendant, `import{writeFileSync}from'node:fs';process.on('SIGTERM',()=>{});writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},100);`);
        const output = path === 'discovery'
          ? 'provider model context max-out thinking images\nfixture fixture 128K 8K no no\n'
          : JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'natural output' }], stopReason: 'stop' } }) + '\n';
        writeFileSync(parent, `import{spawn}from'node:child_process';import{existsSync}from'node:fs';spawn(process.execPath,[${JSON.stringify(descendant)}],{stdio:'ignore'});while(!existsSync(${JSON.stringify(ready)}))await Bun.sleep(5);process.stdout.write(${JSON.stringify(output)});process.stderr.write('diagnostic');process.exit(${code});`);
        const cli = { command: process.execPath, argsPrefix: [parent], label: 'natural-fixture' };
        pending = path === 'discovery'
          ? getExecutableCatalog(true, 1000, undefined, cli)
          : runDelegateProcess([], '', 1000, undefined, undefined, cli);
        await until(() => existsSync(ready), 800);
        pid = Number(readFileSync(ready, 'utf8')); start = identity(pid);
        // Readiness proves the descendant was started. Normal completion may
        // clean it before the observer reads /proc; only final cleanup matters.
        const result = await pending;
        await until(() => identity(pid) === null, 500);
        if (path === 'execution') {
          expect(result.exitCode).toBe(code);
          expect(result.text).toBe('natural output');
          expect(result.stderr).toBe('diagnostic');
        } else if (code === 0) {
          expect(result.lastError).toBeNull();
          expect(result.models.some((model: any) => model.provider === 'fixture')).toBe(true);
        } else expect(result.lastError).toBe('diagnostic');
      } finally {
        await pending;
        if (!pid && existsSync(ready)) pid = Number(readFileSync(ready, 'utf8'));
        const current = pid ? identity(pid) : null;
        if (current && (!start || current === start)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
        rmSync(root, { recursive: true, force: true });
      }
    }, 6000);
  }
}
