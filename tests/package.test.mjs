import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { test } from "node:test";
import { releaseErrors } from "../scripts/check-release.mjs";
import { hostModuleUrl } from "./sdk-modules.mjs";

const root = resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const ready = () => ({
  ...structuredClone(pkg), private: false, name: "@release-check/pi-todo", author: "Example Maintainer",
  repository: { type: "git", url: "git+https://github.com/release-check/pi-todo.git" },
  homepage: "https://github.com/release-check/pi-todo#readme",
  bugs: { url: "https://github.com/release-check/pi-todo/issues" },
});

test("project branding and repository metadata consistently use pi-todo", () => {
  assert.equal(pkg.name, "@mrhadenough/pi-todo");
  assert.equal(pkg.author, "mrhadenough");
  assert.equal(pkg.repository.url, "git+https://github.com/mrhadenough/pi-todo.git");
  assert.equal(pkg.homepage, "https://github.com/mrhadenough/pi-todo#readme");
  assert.equal(pkg.bugs.url, "https://github.com/mrhadenough/pi-todo/issues");
  assert.match(readFileSync(resolve(root, "README.md"), "utf8"), /^# pi-todo\n/);
  assert.match(readFileSync(resolve(root, "LICENSE"), "utf8"), /pi-todo contributors/);
});

test("standalone manifest exposes one extension and only host-provided peers", () => {
  assert.deepEqual(pkg.pi.extensions, ["./index.ts"]);
  assert.ok(pkg.keywords.includes("pi-package"));
  assert.equal(pkg.license, "MIT");
  assert.equal(pkg.engines.node, ">=22.19.0");
  assert.equal(Object.keys(pkg.dependencies ?? {}).length, 0);
  assert.deepEqual(pkg.peerDependencies, {
    "@earendil-works/pi-ai": "*", "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*", typebox: "*",
  });
  assert.match(pkg.scripts.prepublishOnly, /release:check.*npm test.*test:sdk/);
});

test("release guard blocks private/template metadata, but accepts personalized public metadata", () => {
  assert.deepEqual(releaseErrors(ready()), []);
  for (const patch of [
    { private: true }, { private: "false" }, { private: undefined },
    { name: "@your-npm-name/pi-todo" }, { name: "unscoped" },
    { name: "@release-check/another-project" },
    { author: "YOUR NAME" }, { author: "" },
    { repository: { url: "git+https://github.com/your-github-name/pi-todo.git" } },
    { homepage: "https://github.com/your-github-name/pi-todo" },
    { bugs: {} }, { license: undefined }, { publishConfig: { access: "restricted" } },
  ]) assert.ok(releaseErrors({ ...ready(), ...patch }).length > 0, JSON.stringify(patch));
});

test("npm pack contains exactly the standalone sources, docs, scripts and tests", () => {
  const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: root, encoding: "utf8", timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const [archive] = JSON.parse(result.stdout);
  assert.equal(archive.name, pkg.name);
  assert.equal(archive.filename, `${pkg.name.slice(1).replace("/", "-")}-${pkg.version}.tgz`);
  assert.deepEqual(archive.files.map(file => file.path).sort(), [
    "CHANGELOG.md", "CONTRIBUTING.md",
    "LICENSE", "PUBLISHING.md", "README.md", "docs/DESIGN.md", "docs/TESTING.md", "index.ts", "package.json",
    "scripts/check-release.mjs", "scripts/test-package.mjs", "scripts/test-sdk.mjs", "state.mjs",
    "tests/extension.mjs", "tests/package.test.mjs", "tests/sdk-modules.mjs", "tests/state.test.mjs", "view.mjs",
  ].sort());
});

test("documentation links resolve and installation starts with an available local source", () => {
  const docs = ["README.md", "CONTRIBUTING.md", "PUBLISHING.md", "CHANGELOG.md", "docs/DESIGN.md", "docs/TESTING.md"];
  for (const file of docs) {
    const source = readFileSync(resolve(root, file), "utf8");
    assert.doesNotMatch(source, /(?:AGENTS|HANDOFF)\.md|todo-prototype|sandbox-repository/, file);
    for (const [, link] of source.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      if (/^(?:https?:|#)/.test(link)) continue;
      const target = resolve(root, file, "..", link.split("#")[0]);
      assert.ok(target.startsWith(root + "/") || target.startsWith(root + "\\"), `${file}: ${link}`);
      assert.ok(readFileSync(target).length > 0, `${file}: missing ${link}`);
    }
  }
  const readme = readFileSync(resolve(root, "README.md"), "utf8");
  assert.doesNotMatch(readme, /git clone|pi install "\$PWD"|\/absolute\/path\/to\/pi-todo/);
  assert.ok(readme.includes(`pi install npm:${pkg.name}`));
  assert.doesNotMatch(readme, /@<owner>|your-github-name|your-npm-name/);
  const source = "git:github.com/mrhadenough/pi-todo";
  for (const command of [
    `pi install ${source}`, `pi install --local ${source}`,
    `pi -ne -e ${source}`, `pi update ${source}`, `pi remove ${source}`,
  ]) assert.ok(readme.includes(command), `README missing ${command}`);
  assert.match(readme, /not published yet/);
});

test("an explicit missing SDK fails rather than silently skipping or falling back", () => {
  const result = spawnSync(process.execPath, ["scripts/test-sdk.mjs", resolve(root, "missing-sdk-for-test")], {
    cwd: root, encoding: "utf8", timeout: 10_000,
  });
  assert.equal(result.status, 1, result.stderr || result.error?.message);
  assert.match(result.stderr, /Pi SDK not found/);
});


test("SDK host-module lookup supports nested and project-local hoisted dependencies", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "pi-todo-resolution-"));
  try {
    for (const layout of ["nested", "hoisted"]) {
      const scope = resolve(dir, layout, "node_modules/@earendil-works");
      const host = resolve(scope, "pi-coding-agent");
      const dependency = layout === "nested" ? resolve(host, "node_modules/@earendil-works/pi-tui") : resolve(scope, "pi-tui");
      mkdirSync(host, { recursive: true });
      mkdirSync(dependency, { recursive: true });
      writeFileSync(resolve(host, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent" }));
      writeFileSync(resolve(dependency, "package.json"), JSON.stringify({ name: "@earendil-works/pi-tui", exports: "./index.js" }));
      writeFileSync(resolve(dependency, "index.js"), "// resolution fixture\n");
      assert.equal(hostModuleUrl(host, "@earendil-works/pi-tui").href, pathToFileURL(resolve(dependency, "index.js")).href);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test("runtime is session-only and all relative source/test imports stay inside the package", () => {
  const sources = ["index.ts", "state.mjs", "view.mjs", "tests/state.test.mjs", "tests/extension.mjs", "tests/sdk-modules.mjs"];
  for (const file of sources) {
    const source = readFileSync(resolve(root, file), "utf8");
    assert.doesNotMatch(source, /\/workspace\/|\/opt\/sandbox-pi\/|pi\/todo-prototype\//, file);
    for (const [, specifier] of source.matchAll(/\bfrom\s+["'](\.[^"']+)["']/g)) {
      const target = resolve(root, file, "..", specifier);
      assert.ok(target.startsWith(root + "/") || target.startsWith(root + "\\"), `${file}: ${specifier}`);
      assert.ok(readFileSync(target).length > 0, `${file}: missing ${specifier}`);
    }
    if (!file.startsWith("tests/")) {
      assert.doesNotMatch(source, /node:fs|sendUserMessage|pi\.exec\(|setTimeout\(/, file);
    }
  }
});
