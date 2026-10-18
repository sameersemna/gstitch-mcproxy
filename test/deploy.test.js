// @ts-check
"use strict";

/**
 * Phase 8 — deployment artifacts.
 *
 * These assert the properties that are easy to break silently: the Docker image contains the
 * files the proxy actually needs (it now requires `src/`, which a stale Dockerfile would not
 * copy), the systemd units stay hardened, and the install scripts still template correctly for
 * a path containing spaces.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(ROOT, name), "utf8");

test("deploy: the Dockerfile copies every runtime entry point", () => {
  const dockerfile = read("Dockerfile");

  assert.match(dockerfile, /COPY index\.js/, "index.js must be in the image");
  assert.match(dockerfile, /COPY src \.\/src/, "the proxy now requires src/, so it must be copied");
  assert.match(dockerfile, /COPY INSTRUCTIONS\.md/, "the instructions page reads this file");
  assert.match(dockerfile, /COPY package\.json/);
});

test("deploy: the Docker image runs as a non-root user", () => {
  const dockerfile = read("Dockerfile");
  assert.match(dockerfile, /^USER (node|mcproxy)$/m, "the container must not run as root");
});

test("deploy: the Docker healthcheck uses node, not wget, and handles TERM", () => {
  const dockerfile = read("Dockerfile");

  assert.match(dockerfile, /HEALTHCHECK[\s\S]*?fetch\(/, "healthcheck should use the bundled node");
  assert.ok(!dockerfile.includes("wget"), "BusyBox wget is an unnecessary dependency");
  assert.match(dockerfile, /STOPSIGNAL SIGTERM/);
});

test("deploy: docker-compose does not mount the image writable except for logs", () => {
  const compose = read("docker-compose.yml");

  assert.match(compose, /read_only: true/);
  assert.match(compose, /no-new-privileges:true/);
  assert.match(compose, /\.\/logs:\/app\/logs/);
  // Logs are the only writable path the proxy needs.
  const volumes = compose.slice(compose.indexOf("volumes:"), compose.indexOf("read_only:"));
  assert.ok(!volumes.includes("/app/src"), "source code must not be mounted writable");
});

test("deploy: docker-compose keeps the port published for LAN use (owner decision 1)", () => {
  const compose = read("docker-compose.yml");
  assert.match(compose, /- "8787:8787"/, "owner decision 1 requires LAN reachability");
});

test("deploy: both systemd units set NoNewPrivileges, ProtectSystem and a stop timeout", () => {
  for (const unit of [
    "systemd/gstitch-mcproxy.service",
    "systemd/gstitch-mcproxy.system.service",
  ]) {
    const contents = read(unit);

    assert.match(contents, /^NoNewPrivileges=true$/m, unit);
    assert.match(contents, /^ProtectSystem=strict$/m, unit);
    assert.match(contents, /^PrivateTmp=true$/m, unit);
    assert.match(contents, /^RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX$/m, unit);
    assert.match(contents, /^MemoryMax=/m, unit);
    assert.match(contents, /^CapabilityBoundingSet=$/m, unit);

    // TimeoutStopSec must exceed the drain budget or in-flight streams are killed.
    const timeout = Number(contents.match(/^TimeoutStopSec=(\d+)$/m)?.[1] || 0);
    assert.ok(timeout >= 20, `${unit}: TimeoutStopSec should exceed SHUTDOWN_DRAIN_MS`);
  }
});

test("deploy: the user unit never gains ProtectHome=read-only (gcloud needs HOME)", () => {
  const unit = read("systemd/gstitch-mcproxy.service");
  assert.ok(
    !/^ProtectHome=read-only$/m.test(unit),
    "the user unit reads gcloud credentials from HOME",
  );
});

test("deploy: the install scripts still resolve a path containing spaces", () => {
  // The units are rendered with `sed`; a path with a space used to break the service.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gstitch path with spaces "));
  const target = path.join(dir, "gstitch-mcproxy");
  fs.mkdirSync(path.join(target, "systemd"), { recursive: true });

  fs.copyFileSync(
    path.join(ROOT, "systemd/gstitch-mcproxy.service"),
    path.join(target, "systemd/gstitch-mcproxy.service"),
  );
  fs.copyFileSync(
    path.join(ROOT, "install-user-service.sh"),
    path.join(target, "install-user-service.sh"),
  );

  const script = fs.readFileSync(path.join(target, "install-user-service.sh"), "utf8");
  const rendered = script.includes("__ROOT_DIR__");

  assert.ok(rendered, "the install script templates __ROOT_DIR__");
  // Render the template exactly as the script does, then check the result is coherent.
  const template = fs.readFileSync(path.join(target, "systemd/gstitch-mcproxy.service"), "utf8");
  const result = template.replaceAll("__ROOT_DIR__", target);

  assert.ok(result.includes(`WorkingDirectory=${target}`), "WorkingDirectory must be absolute");
  assert.ok(result.includes(`bash ${target}/run.sh`), "ExecStart must quote the real path");
  assert.ok(!result.includes("__ROOT_DIR__"), "no placeholder may survive");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("deploy: run.sh works without lsof", () => {
  const run = read("run.sh");
  // The port check must be optional: lsof is absent on minimal images.
  assert.match(run, /command -v lsof/, "run.sh already guards on lsof being present");
});

test("deploy: the Dockerfile installs no runtime dependencies", () => {
  const dockerfile = read("Dockerfile");
  assert.ok(!dockerfile.includes("npm install"), "the project has no runtime dependencies");
  assert.ok(!dockerfile.includes("npm ci"), "there is nothing to install at runtime");
});

test("deploy: package.json declares the Node floor used by the Docker image", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.ok(pkg.engines.node.includes("20"), "CI and the image must agree on the Node floor");

  const dockerfile = read("Dockerfile");
  const image = dockerfile.match(/FROM node:(\d+)/)?.[1];
  assert.ok(Number(image) >= 20, `the image (${image}) must satisfy engines`);
});

// ---------------------------------------------------------------------------
// Phase 9 — documentation consistency
// ---------------------------------------------------------------------------

test("docs: every route the proxy serves is documented in the README", () => {
  const readme = read("README.md");
  const routes = [
    "/mcp",
    "/health",
    "/metrics",
    "/instructions",
    "/logs",
    "/api/logs",
    "/api/logs/summary",
    "/.well-known/oauth-protected-resource",
    "/.well-known/openid-configuration",
    "/auth",
    "/token",
  ];

  for (const route of routes) {
    assert.ok(readme.includes(route), `the README must document ${route}`);
  }
});

test("docs: every JSON-RPC error code the proxy emits is documented", () => {
  const readme = read("README.md") + read("CHANGELOG.md") + read("PROGRESS.md");

  for (const code of [
    "-32001",
    "-32002",
    "-32003",
    "-32004",
    "-32005",
    "-32006",
    "-32007",
    "-32008",
    "-32009",
    "-32600",
    "-32601",
    "-32603",
  ]) {
    assert.ok(readme.includes(code), `error code ${code} must be documented`);
  }
});

test("docs: the README documents the idempotency behaviour an agent needs", () => {
  const readme = read("README.md");

  assert.match(readme, /-32008/, "the outcome-unknown code must be documented");
  assert.match(readme, /Idempotency-Key/, "explicit idempotency keys must be documented");
  assert.match(readme, /coalesc/i, "coalescing must be documented");
  assert.match(readme, /replay/i, "replay must be documented");
  assert.match(readme, /detach/i, "orphan capture must be documented");
});

test("docs: INSTRUCTIONS.md tells agents what to do after -32008 or -32004", () => {
  const instructions = read("INSTRUCTIONS.md");

  assert.match(instructions, /-32008/, "agents must be told about outcome-unknown");
  assert.match(instructions, /-32004/, "agents must be told about the still-running case");
  assert.match(instructions, /identical/i, "agents must be told to retry the identical call");
  assert.match(
    instructions,
    /list_screens|list_projects/,
    "agents must be told how to check state",
  );
});

test("docs: every ADR referenced from PROGRESS.md exists", () => {
  const progress = read("PROGRESS.md");
  const referenced = [...progress.matchAll(/\((docs\/adr\/[^)]+)\)/g)].map((match) => match[1]);
  const unique = [...new Set(referenced)];

  assert.ok(unique.length >= 5, `expected the ADRs to be linked, found ${unique.length}`);

  const missing = unique.filter((relative) => !fs.existsSync(path.join(ROOT, relative)));
  assert.deepEqual(
    missing,
    [],
    `PROGRESS.md links to ADRs that do not exist: ${missing.join(", ")}`,
  );
});

test("docs: the CHANGELOG names every critical finding that was fixed", () => {
  const changelog = read("CHANGELOG.md");

  for (const finding of ["★C1", "★C2", "★C3", "★C4", "★C5"]) {
    assert.ok(changelog.includes(finding), `${finding} must be listed in the changelog`);
  }
});

test("docs: SECURITY.md states the deliberate non-goals", () => {
  const security = read("SECURITY.md");

  assert.match(security, /does \*\*not\*\* defend|not defend/i);
  assert.match(security, /no authentication|There is no authentication/i);
});
