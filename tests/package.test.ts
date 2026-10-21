import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const [packed] = JSON.parse(
	execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
		cwd: root,
		encoding: "utf8",
	}),
);
const files: Array<{ path: string; mode: number }> = packed.files;

test("the tarball includes executable helpers and notices without inactive upstream features", () => {
	const paths = files.map((file) => file.path);
	expect(paths).toContain("index.ts");
	expect(paths).toContain("src/voice/dictation/transcriber.ts");
	expect(paths).toContain("LICENSE");
	expect(paths).toContain("THIRD-PARTY-NOTICES.txt");
	expect(paths).toContain("src/voice/rust/vendor/openai-codex/LICENSE");
	expect(paths).toContain("src/voice/rust/vendor/openai-codex/NOTICE");
	expect(paths).toContain("licenses/rust-std-COPYRIGHT-library.html");
	for (const platform of ["darwin-arm64", "linux-x64"]) {
		const helper = files.find(
			(file) => file.path === `src/voice/bin/${platform}/pi-codex-voice`,
		);
		expect(helper).toBeDefined();
		expect(helper!.mode & 0o111).not.toBe(0);
	}
	expect(
		paths.filter((path) =>
			/^(?:scripts\/|tests\/|node_modules\/|dist\/|\.release\/|src\/voice\/lan\/)|^UPSTREAM_README\.md$|(?:^|\/)(?:\.env(?:\..*)?|\.npmrc|auth\.json|AGENTS\.md)$/.test(
				path,
			),
		),
	).toEqual([]);
});

test("packed files contain no private paths or credentials, including in native helpers", () => {
	const leaks = files
		.filter((file) =>
			/\/(?:Users|home)\/|[A-Za-z]:\\Users\\|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bnpm_[A-Za-z0-9]{30,}\b|\bsk-(?:proj-|svcacct-)[A-Za-z0-9_-]{20,}/.test(
				readFileSync(new URL(file.path, `file://${root}`)).toString("latin1"),
			),
		)
		.map((file) => file.path);
	expect(leaks).toEqual([]);
});

test("the OMP manifest has matching versions and packable extension entry points", () => {
	const manifest = JSON.parse(
		readFileSync(new URL("../package.json", import.meta.url), "utf8"),
	);
	expect(manifest.omp.version).toBe(manifest.version);
	expect(manifest.omp.extensions.length).toBeGreaterThan(0);
	for (const entry of manifest.omp.extensions) {
		expect(files.map((file) => file.path)).toContain(
			entry.replace(/^\.\//, ""),
		);
	}
});
