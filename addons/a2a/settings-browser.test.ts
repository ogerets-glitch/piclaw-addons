import { createRequire } from "node:module";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Browser binary and core CSS are explicit local fixture dependencies, never a live URL.
const enabled =
  process.env.PICLAW_E2E_DISPOSABLE === "1" &&
  !!process.env.PICLAW_A2A_CORE_SOURCE;
const browserTest = enabled ? test : test.skip;
let browser: any,
  server: ReturnType<typeof Bun.serve>,
  root = "";
let saved: any[] = [];
const empty = {
  enabled: false,
  inbound: false,
  outbound: false,
  publicBaseUrl: "",
  agents: [],
  principals: [],
  endpoints: [],
};
beforeAll(async () => {
  if (!enabled) return;
  const core = process.env.PICLAW_A2A_CORE_SOURCE!;
  const { chromium } = await import(
    join(core, "node_modules/playwright/index.mjs")
  );
  const hostRequire = createRequire(join(core, "package.json"));
  const preact = hostRequire.resolve("preact"), hooks = hostRequire.resolve("preact/hooks"), htm = hostRequire.resolve("htm");
  root = mkdtempSync(join(tmpdir(), "a2a-ui-"));
  const bundle = await Bun.build({
    entrypoints: [new URL("./web/index.ts", import.meta.url).pathname],
    target: "browser",
    format: "esm",
  });
  if (!bundle.success) throw new Error(String(bundle.logs));
  const shim = join(root, "shim.ts");
  await Bun.write(
    shim,
    `import {h,render} from ${JSON.stringify(preact)};import {useEffect,useState} from ${JSON.stringify(hooks)};import htm from ${JSON.stringify(htm)};window.__piclawPreactHtm={html:htm.bind(h),useEffect,useState};window.__piclaw_web={registerSettingsPane(p){if(!p.component)throw new Error('Host requires component');render(h(p.component),document.getElementById('app'));}};await import('/settings.js');`,
  );
  const compiled = await Bun.build({
    entrypoints: [shim],
    target: "browser",
    format: "esm",
    external: ["/settings.js"],
    plugins: [
      {
        name: "preact-resolution",
        setup(build) {
          build.onResolve({ filter: /^preact$/ }, () => ({
            path: preact,
          }));
        },
      },
    ],
  });
  if (!compiled.success) throw new Error(String(compiled.logs));
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/settings.js")
        return new Response(await bundle.outputs[0].text(), {
          headers: { "content-type": "text/javascript" },
        });
      if (url.pathname === "/shim.js")
        return new Response(await compiled.outputs[0].text(), {
          headers: { "content-type": "text/javascript" },
        });
      if (url.pathname === "/style.css")
        return new Response(
          Bun.file(
            join(
              core,
              "runtime/web/static",
              url.searchParams.get("skin") === "visual"
                ? "visual/dist/app.bundle.css"
                : "classic/dist/app.bundle.css",
            ),
          ),
          { headers: { "content-type": "text/css" } },
        );
      if (url.pathname.endsWith("/config")) {
        if (req.method === "POST") {
          const body = await req.json();
          saved.push(body);
          return Response.json({ ok: true, config: body });
        }
        return Response.json(empty);
      }
      if (url.pathname.endsWith("/status"))
        return Response.json({
          enabled: false,
          stage: "service-candidate",
          activeRequests: 0,
        });
      return new Response(
        '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css?skin=' +
          url.searchParams.get("skin") +
          '"><style>body{padding:16px;margin:0}#app{max-width:680px;margin:auto}</style></head><body><main id="app"></main><script type="module" src="/shim.js"></script></body></html>',
        { headers: { "content-type": "text/html" } },
      );
    },
  });
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser?.close();
  server?.stop(true);
  if (root) rmSync(root, { recursive: true, force: true });
});
for (const skin of ["classic", "visual"])
  for (const width of [1024, 390])
    browserTest(
      `A2A direct settings in ${skin} at ${width}px`,
      async () => {
        const page = await browser.newPage({
          viewport: { width, height: 1100 },
        });
        saved = [];
        const errors: string[] = [];
        page.on("pageerror", (e: Error) => errors.push(e.message));
        try {
          await page.goto(server.url + "?skin=" + skin);
          await page
            .getByRole("button", { name: "Save A2A settings" })
            .waitFor();
          await page.waitForFunction(
            () =>
              !(document.querySelector("button") as HTMLButtonElement)
                ?.disabled,
          );
          expect(
            await page
              .locator(".a2a-settings")
              .evaluate((e: HTMLElement) => e.scrollWidth <= e.clientWidth + 1),
          ).toBe(true);
          expect(
            await page
              .getByRole("textbox", { name: "Inbound principals (JSON)" })
              .inputValue(),
          ).toBe("[]");
          await page
            .getByRole("checkbox", { name: "Enable A2A", exact: true })
            .check();
          await page.getByRole("button", { name: "Save A2A settings" }).click();
          await page
            .getByRole("alert")
            .filter({ hasText: "Confirm reviewed grants" })
            .waitFor();
          expect(saved).toHaveLength(0);
          await page
            .getByRole("checkbox", {
              name: "I reviewed grants and credentials",
            })
            .check();
          await page.getByRole("button", { name: "Save A2A settings" }).click();
          await page
            .getByRole("status")
            .filter({ hasText: "Settings saved" })
            .waitFor();
          expect(saved[0].enabled).toBe(true);
          await page.getByRole("button", { name: "Disable A2A now" }).click();
          await page
            .getByRole("status")
            .filter({ hasText: "A2A disabled" })
            .waitFor();
          expect(saved.at(-1).enabled).toBe(false);
          expect(errors).toEqual([]);
          const out = process.env.PICLAW_A2A_EVIDENCE_DIR;
          if (out) {
            mkdirSync(out, { recursive: true });
            await page.screenshot({
              path: join(out, `settings-${skin}-${width}.png`),
              fullPage: true,
            });
          }
        } finally {
          await page.close();
        }
      },
      15000,
    );
