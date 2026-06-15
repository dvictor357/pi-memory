/**
 * memory.ts — persistent project & user memory for pi
 *
 * Every new session already knows what project you're in and how you like to
 * work. Auto-detects tech stack, watches for conventions, and injects a
 * concise profile into the system prompt so pi never starts cold.
 *
 * Storage
 * -------
 *   ~/.pi/agent/memory/user.json          — your style, learned over time
 *   ~/.pi/agent/memory/projects/<hash>.json — per-project, auto-detected
 *
 * Tools
 * -----
 *   memory_status   — show both profiles (what pi knows)
 *   memory_user     — view / set user-level preferences & conventions
 *   memory_project  — view / set project-level conventions
 *
 * Commands
 * --------
 *   /memory                      — alias for memory_status
 *   /memory project <key=value>  — set a project convention
 *   /memory user <key=value>     — set a user preference
 *   /memory rescan               — force re-detect project tech stack
 *   /memory clear                — reset all memory for this project
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

// ── Types ────────────────────────────────────────────────────────────────────

interface ProjectProfile {
	name: string;
	packageManager: string | null;
	language: string | null;
	framework: string | null;
	designSystem: string | null;
	buildTool: string | null;
	testRunner: string | null;
	linter: string | null;
	formatter: string | null;
	monorepo: boolean;
	directoryPattern: string | null;
	conventions: string[];
	lastScanned: number; // epoch ms
}

interface UserProfile {
	communication: string | null;
	commitStyle: string | null;
	indent: string | null;
	quotes: string | null;
	preferredPackageManager: string | null;
	errorHandling: string | null;
	shell: string | null;
	conventions: string[];
	lastModified: number;
}

const USER_PATH = join(homedir(), ".pi", "agent", "memory", "user.json");
const PROJECTS_DIR = join(homedir(), ".pi", "agent", "memory", "projects");

function projectPath(cwd: string): string {
	const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
	return join(PROJECTS_DIR, `${hash}.json`);
}

// ── Storage ──────────────────────────────────────────────────────────────────

function readJSON<T>(path: string, fallback: T): T {
	try {
		if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
	} catch { /* corrupt → fallback */ }
	return fallback;
}

function writeJSON(path: string, data: unknown): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
	} catch { /* best-effort */ }
}

function loadProject(cwd: string): ProjectProfile {
	return readJSON<ProjectProfile>(projectPath(cwd), {
		name: basename(cwd),
		packageManager: null,
		language: null,
		framework: null,
		designSystem: null,
		buildTool: null,
		testRunner: null,
		linter: null,
		formatter: null,
		monorepo: false,
		directoryPattern: null,
		conventions: [],
		lastScanned: 0,
	});
}

function saveProject(cwd: string, profile: ProjectProfile): void {
	profile.lastScanned = Date.now();
	writeJSON(projectPath(cwd), profile);
}

function loadUser(): UserProfile {
	return readJSON<UserProfile>(USER_PATH, {
		communication: null,
		commitStyle: null,
		indent: null,
		quotes: null,
		preferredPackageManager: null,
		errorHandling: null,
		shell: process.env.SHELL?.split("/").pop() ?? null,
		conventions: [],
		lastModified: 0,
	});
}

function saveUser(profile: UserProfile): void {
	profile.lastModified = Date.now();
	writeJSON(USER_PATH, profile);
}

// ── Auto-detection ───────────────────────────────────────────────────────────

interface Detector {
	(cwd: string, pkgJSON: Record<string, any> | null): string | null;
}

/** Check if a file or directory exists relative to cwd. */
function has(cwd: string, ...paths: string[]): boolean {
	return existsSync(join(cwd, ...paths));
}

/** Check if a dep exists in package.json */
function hasDep(pkg: Record<string, any> | null, name: string): boolean {
	if (!pkg) return false;
	const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
	return name in deps;
}

/** Count files with a given extension (capped at 100). */
function countExt(cwd: string, ext: string): number {
	let n = 0;
	try {
		walkDir(cwd, (f) => {
			if (f.endsWith(ext)) n++;
			return n < 100;
		});
	} catch { /* ignore */ }
	return n;
}

function walkDir(dir: string, fn: (f: string) => boolean, depth = 0): void {
	if (depth > 3) return;
	let entries: string[];
	try { entries = readdirSync(dir); } catch { return; }
	for (const e of entries) {
		if (e.startsWith(".") && e !== ".pi") continue;
		if (e === "node_modules" || e === "target" || e === "__pycache__" || e === ".git") continue;
		const full = join(dir, e);
		let st: { isDirectory(): boolean; isFile(): boolean };
		try { st = statSync(full); } catch { continue; }
		if (st.isDirectory()) walkDir(full, fn, depth + 1);
		else if (st.isFile() && !fn(full)) return;
	}
}

function readPkg(cwd: string): Record<string, any> | null {
	const p = join(cwd, "package.json");
	try {
		if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8"));
	} catch { /* ignore */ }
	return null;
}

function readPyProject(cwd: string): Record<string, any> | null {
	const p = join(cwd, "pyproject.toml");
	try {
		if (!existsSync(p)) return null;
		// Simple TOML parsing just for dependency sections
		const raw = readFileSync(p, "utf8");
		// Extract [project] dependencies as a simple check
		const hasDeps = /\[project\]/.test(raw) || /\[tool\.poetry\]/.test(raw);
		return hasDeps ? { _hasPyProject: true } : null;
	} catch { return null; }
}

/** Detect package manager from lock/config files, in priority order. */
function detectPackageManager(cwd: string, _pkg: Record<string, any> | null): string | null {
	if (has(cwd, "bun.lockb") || has(cwd, "bun.lock")) return "bun";
	if (has(cwd, "pnpm-lock.yaml")) return "pnpm";
	if (has(cwd, "yarn.lock")) return "yarn";
	if (has(cwd, "package-lock.json")) return "npm";
	if (has(cwd, "uv.lock")) return "uv";
	if (has(cwd, "poetry.lock")) return "poetry";
	if (has(cwd, "Pipfile.lock")) return "pipenv";
	if (has(cwd, "Cargo.lock")) return "cargo";
	if (has(cwd, "Gemfile.lock")) return "bundler";
	if (has(cwd, "go.sum")) return "go mod";
	if (has(cwd, "mix.lock")) return "mix";
	return null;
}

/** Detect primary language by counting source files. */
function detectLanguage(cwd: string, _pkg: Record<string, any> | null): string | null {
	const counts: Record<string, number> = {};
	for (const ext of [".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".go", ".rb", ".ex", ".exs", ".java", ".kt", ".swift", ".c", ".cpp", ".h", ".hpp"]) {
		const n = countExt(cwd, ext);
		if (n > 0) counts[ext] = n;
	}
	if (Object.keys(counts).length === 0) return null;
	const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
	switch (best[0]) {
		case ".ts": case ".tsx": return "TypeScript";
		case ".js": case ".jsx": return "JavaScript";
		case ".py": return "Python";
		case ".rs": return "Rust";
		case ".go": return "Go";
		case ".rb": return "Ruby";
		case ".ex": case ".exs": return "Elixir";
		case ".java": return "Java";
		case ".kt": return "Kotlin";
		case ".swift": return "Swift";
		case ".c": case ".cpp": case ".h": case ".hpp": return "C/C++";
		default: return best[0].slice(1).toUpperCase();
	}
}

/** Detect web / backend framework from config files and dependencies. */
function detectFramework(cwd: string, pkg: Record<string, any> | null): string | null {
	// JavaScript / TypeScript
	if (hasDep(pkg, "next")) return "Next.js";
	if (hasDep(pkg, "remix") || hasDep(pkg, "@remix-run/react")) return "Remix";
	if (hasDep(pkg, "astro")) return "Astro";
	if (has(cwd, "svelte.config.js") || hasDep(pkg, "svelte")) return "Svelte";
	if (hasDep(pkg, "nuxt") || has(cwd, "nuxt.config.ts")) return "Nuxt";
	if ((hasDep(pkg, "vue") || hasDep(pkg, "@vue")) && hasDep(pkg, "vite")) return "Vue + Vite";
	if (hasDep(pkg, "react") || hasDep(pkg, "preact")) {
		if (has(cwd, "vite.config.")) return "React + Vite";
		if (has(cwd, "remix.config.")) return "Remix";
		return "React";
	}
	if (has(cwd, "next.config.")) return "Next.js";
	if (has(cwd, "vite.config.")) return "Vite";
	if (hasDep(pkg, "express")) return "Express";
	if (hasDep(pkg, "fastify")) return "Fastify";
	if (hasDep(pkg, "koa")) return "Koa";
	if (hasDep(pkg, "hono")) return "Hono";
	if (hasDep(pkg, "elysia")) return "Elysia";

	// Python
	if (hasDep(pkg, "fastapi")) return "FastAPI";
	if (hasDep(pkg, "flask")) return "Flask";
	if (hasDep(pkg, "django")) return "Django";
	if (has(cwd, "manage.py")) return "Django";
	const py = readPyProject(cwd);
	if (py) {
		const raw = readFileSync(join(cwd, "pyproject.toml"), "utf8");
		if (/fastapi/i.test(raw)) return "FastAPI";
		if (/flask/i.test(raw)) return "Flask";
		if (/django/i.test(raw)) return "Django";
	}

	// Rust
	if (has(cwd, "Cargo.toml")) {
		const cargo = readFileSync(join(cwd, "Cargo.toml"), "utf8");
		if (/actix-web|actix_web/i.test(cargo)) return "Actix Web";
		if (/axum/i.test(cargo)) return "Axum";
		if (/rocket/i.test(cargo)) return "Rocket";
		if (/leptos/i.test(cargo)) return "Leptos";
		if (/yew/i.test(cargo)) return "Yew";
		if (/tauri/i.test(cargo)) return "Tauri";
		return null;
	}

	return null;
}

/** Detect design system / UI library. */
function detectDesignSystem(cwd: string, pkg: Record<string, any> | null): string | null {
	if (has(cwd, "tailwind.config.") || hasDep(pkg, "tailwindcss")) {
		if (hasDep(pkg, "@radix-ui") || hasDep(pkg, "shadcn-ui") || has(cwd, "components.json")) return "Tailwind + shadcn/ui";
		if (hasDep(pkg, "daisyui")) return "Tailwind + DaisyUI";
		if (hasDep(pkg, "flowbite") || hasDep(pkg, "flowbite-react")) return "Tailwind + Flowbite";
		if (hasDep(pkg, "headlessui") || hasDep(pkg, "@headlessui/react")) return "Tailwind + Headless UI";
		return "Tailwind CSS";
	}
	if (hasDep(pkg, "@mui/material") || hasDep(pkg, "@mui/icons-material")) return "MUI";
	if (hasDep(pkg, "@chakra-ui/react")) return "Chakra UI";
	if (hasDep(pkg, "antd")) return "Ant Design";
	if (hasDep(pkg, "bootstrap")) return "Bootstrap";
	if (hasDep(pkg, "@mantine/core")) return "Mantine";
	if (hasDep(pkg, "@nextui-org/react") || hasDep(pkg, "heroui")) return "NextUI";
	return null;
}

/** Detect build tool. */
function detectBuildTool(cwd: string, pkg: Record<string, any> | null): string | null {
	if (has(cwd, "vite.config.")) return "Vite";
	if (has(cwd, "tsup.config.")) return "tsup";
	if (has(cwd, "rollup.config.")) return "Rollup";
	if (has(cwd, "webpack.config.")) return "Webpack";
	if (has(cwd, "esbuild.config.")) return "esbuild";
	if (has(cwd, "turbo.json")) return "Turbopack";
	if (has(cwd, "tsconfig.json") && !hasDep(pkg, "vite") && !hasDep(pkg, "next")) return "tsc";
	if (hasDep(pkg, "tsup")) return "tsup";
	if (hasDep(pkg, "unbuild")) return "unbuild";
	if (has(cwd, "Cargo.toml")) return "Cargo";
	if (has(cwd, "setup.py") || has(cwd, "pyproject.toml")) return "setuptools";
	return null;
}

/** Detect test runner. */
function detectTestRunner(cwd: string, pkg: Record<string, any> | null): string | null {
	if (has(cwd, "vitest.config.") || hasDep(pkg, "vitest")) return "Vitest";
	if (hasDep(pkg, "jest")) return "Jest";
	if (hasDep(pkg, "mocha")) return "Mocha";
	if (hasDep(pkg, "ava")) return "AVA";
	if (hasDep(pkg, "playwright") || hasDep(pkg, "@playwright/test")) return "Playwright";
	if (hasDep(pkg, "cypress")) return "Cypress";
	if (hasDep(pkg, "pytest")) return "pytest";
	if (hasDep(pkg, "unittest")) return "unittest";
	if (has(cwd, "Cargo.toml")) {
		const cargo = readFileSync(join(cwd, "Cargo.toml"), "utf8");
		if (/\[dev-dependencies\]/.test(cargo)) return "cargo test";
	}
	if (has(cwd, "spec") || has(cwd, "test")) {
		try {
			const entries = readdirSync(join(cwd, "spec"));
			if (entries.some(e => e.endsWith("_spec.rb"))) return "RSpec";
		} catch {}
	}
	return null;
}

/** Detect linter. */
function detectLinter(cwd: string, pkg: Record<string, any> | null): string | null {
	if (has(cwd, "biome.json") || has(cwd, "biome.jsonc")) return "Biome";
	if (has(cwd, "eslint.config.js") || has(cwd, "eslint.config.mjs") || has(cwd, "eslint.config.ts") || has(cwd, ".eslintrc.js") || has(cwd, ".eslintrc.json") || has(cwd, ".eslintrc.yaml")) return "ESLint";
	if (has(cwd, "oxlintrc.json") || has(cwd, ".oxlintrc.json")) return "Oxlint";
	if (hasDep(pkg, "eslint")) return "ESLint";
	if (hasDep(pkg, "oxlint")) return "Oxlint";

	// Python
	const py = readPyProject(cwd);
	if (py) {
		const raw = readFileSync(join(cwd, "pyproject.toml"), "utf8");
		if (/\[tool\.ruff\]/.test(raw)) return "Ruff";
		if (/\[tool\.pylint\]/.test(raw)) return "Pylint";
	}

	// Ruby
	if (has(cwd, ".rubocop.yml")) return "Rubocop";

	// Rust
	if (has(cwd, "Cargo.toml")) {
		const cargo = readFileSync(join(cwd, "Cargo.toml"), "utf8");
		if (/clippy/i.test(cargo)) return "Clippy";
	}

	return null;
}

/** Detect formatter. */
function detectFormatter(cwd: string, pkg: Record<string, any> | null): string | null {
	if (has(cwd, "biome.json") || has(cwd, "biome.jsonc")) return "Biome";
	if (has(cwd, ".prettierrc") || has(cwd, ".prettierrc.json") || has(cwd, ".prettierrc.yaml") || has(cwd, ".prettierrc.js") || has(cwd, "prettier.config.")) return "Prettier";
	if (hasDep(pkg, "prettier")) return "Prettier";
	if (hasDep(pkg, "dprint")) return "dprint";

	// Python
	const py = readPyProject(cwd);
	if (py) {
		const raw = readFileSync(join(cwd, "pyproject.toml"), "utf8");
		if (/\[tool\.ruff\]/.test(raw)) return "Ruff";
		if (/\[tool\.black\]/.test(raw)) return "Black";
	}

	return null;
}

/** Detect directory architecture pattern. */
function detectDirectoryPattern(cwd: string, _pkg: Record<string, any> | null): string | null {
	// Go standard
	if (has(cwd, "cmd") && has(cwd, "internal") && has(cwd, "pkg")) return "Go standard (cmd/internal/pkg)";

	// Next.js App Router
	if ((has(cwd, "app/layout.tsx") || has(cwd, "app/layout.ts")) && has(cwd, "app/page.tsx")) return "Next.js App Router";

	// Feature-based
	if (has(cwd, "src/features") || has(cwd, "features")) return "Feature-based";

	// Layer-based React
	const layers = ["components", "hooks", "utils", "pages", "services", "stores"];
	const layerCount = layers.filter(l => has(cwd, "src", l) || has(cwd, l)).length;
	if (layerCount >= 3) return "Layer-based (components/hooks/utils/...)";

	// MVC
	const mvcCount = ["models", "views", "controllers"].filter(d => has(cwd, "src", d) || has(cwd, d)).length;
	if (mvcCount >= 2) return "MVC";

	// Flat
	const flatDirs = ["src", "lib", "utils", "helpers"];
	if (flatDirs.some(d => has(cwd, d))) return "Flat";

	return null;
}

/** Auto-detect commit style from recent commits. */
function detectCommitStyle(cwd: string): string | null {
	try {
		const log = execSync("git log --oneline -20 --no-decorator 2>/dev/null", { cwd, encoding: "utf8", timeout: 3000 });
		const lines = log.trim().split("\n").filter(Boolean);
		if (lines.length === 0) return null;
		// Count conventional commit format: type(scope): message
		const conventional = /^\w+(\s*\(.*?\))?!?:\s/.test(lines[0]);
		// Count how many match
		const matchCount = lines.filter(l => /^\w+(\s*\(.*?\))?!?:\s/.test(l)).length;
		if (matchCount >= lines.length * 0.6) return "conventional";
		// Check other patterns
		const imperative = lines.filter(l => /^[A-Z][a-z]/.test(l)).length;
		if (imperative >= lines.length * 0.6) return "imperative";
		return "mixed";
	} catch {
		return null;
	}
}

/** Auto-detect indent style from project files. */
function detectIndent(cwd: string): string | null {
	// Check .editorconfig first
	const ec = join(cwd, ".editorconfig");
	if (existsSync(ec)) {
		try {
			const content = readFileSync(ec, "utf8");
			const tabMatch = /indent_style\s*=\s*tab/.test(content);
			if (tabMatch) return "tabs";
			const spaceMatch = /indent_style\s*=\s*space/.test(content);
			if (spaceMatch) {
				const sizeMatch = content.match(/indent_size\s*=\s*(\d+)/);
				return `spaces-${sizeMatch?.[1] ?? "2"}`;
			}
		} catch {}
	}
	// Check Prettier config
	if (has(cwd, ".prettierrc")) {
		try {
			const pr = JSON.parse(readFileSync(join(cwd, ".prettierrc"), "utf8"));
			if (pr.useTabs) return "tabs";
			if (pr.tabWidth) return `spaces-${pr.tabWidth}`;
		} catch {}
	}
	// Sample a ts/tsx file
	for (const dir of ["src", "app", "lib", "."]) {
		const full = join(cwd, dir);
		if (!existsSync(full)) continue;
		try {
			const entries = readdirSync(full);
			const tsFile = entries.find(e => e.endsWith(".ts") && !e.endsWith(".d.ts"));
			if (tsFile) {
				const content = readFileSync(join(full, tsFile), "utf8");
				// Count tab vs space indents in first 50 non-empty lines
				let tabLines = 0, spaceLines = 0;
				for (const line of content.split("\n").slice(0, 50)) {
					if (line.startsWith("\t")) tabLines++;
					else if (line.startsWith("  ")) spaceLines++;
				}
				if (tabLines > spaceLines) return "tabs";
				if (spaceLines > 0) {
					// Check space size
					const match = content.match(/^ {2,}(?=\S)/m);
					const size = match ? match[0].length : 2;
					return `spaces-${size}`;
				}
			}
		} catch {}
	}
	return null;
}

// ── Full detection pipeline ──────────────────────────────────────────────────

function detectProject(cwd: string): ProjectProfile {
	const pkg = readPkg(cwd);
	const name = pkg?.name ?? basename(cwd);

	return {
		name,
		packageManager: detectPackageManager(cwd, pkg),
		language: detectLanguage(cwd, pkg),
		framework: detectFramework(cwd, pkg),
		designSystem: detectDesignSystem(cwd, pkg),
		buildTool: detectBuildTool(cwd, pkg),
		testRunner: detectTestRunner(cwd, pkg),
		linter: detectLinter(cwd, pkg),
		formatter: detectFormatter(cwd, pkg),
		monorepo: has(cwd, "pnpm-workspace.yaml") || has(cwd, "lerna.json") || !!(pkg?.workspaces),
		directoryPattern: detectDirectoryPattern(cwd, pkg),
		conventions: [], // filled manually by agent
		lastScanned: Date.now(),
	};
}

/** Reconcile: merge auto-detected fields into stored profile, preserving manually set conventions. */
function reconcile(cwd: string, stored: ProjectProfile): ProjectProfile {
	const fresh = detectProject(cwd);
	return {
		...fresh,
		conventions: stored.conventions, // preserve manual
		lastScanned: Date.now(),
	};
}

function detectUser(cwd: string): Partial<UserProfile> {
	return {
		commitStyle: detectCommitStyle(cwd),
		indent: detectIndent(cwd),
	};
}

// ── System prompt builder ────────────────────────────────────────────────────

function buildPromptBlock(project: ProjectProfile, user: UserProfile): string {
	const lines: string[] = ["## Profile"];

	// Project
	const tech = [
		project.language,
		project.packageManager,
		project.framework,
		project.buildTool,
	].filter(Boolean);
	const extras = [
		project.designSystem ? `Design: ${project.designSystem}` : null,
		project.directoryPattern ? `Structure: ${project.directoryPattern}` : null,
		project.testRunner ? `Tests: ${project.testRunner}` : null,
		project.linter ? `Lint: ${project.linter}` : null,
		project.formatter ? `Format: ${project.formatter}` : null,
		project.monorepo ? "Monorepo" : null,
	].filter(Boolean);

	lines.push(`**Project:** ${project.name} (${tech.join(" • ") || "unknown"})`);
	if (extras.length) lines.push(extras.join(" • "));
	if (project.conventions.length) {
		lines.push(`Conventions: ${project.conventions.join(", ")}`);
	}

	// User
	if (user.conventions.length || user.commitStyle || user.indent) {
		const userBits = [
			user.commitStyle ? `${user.commitStyle} commits` : null,
			user.indent,
			user.quotes ? `${user.quotes} quotes` : null,
			user.errorHandling,
			user.communication,
		].filter(Boolean);
		if (userBits.length || user.conventions.length) {
			lines.push("");
			lines.push("**You:**");
			if (userBits.length) lines.push(userBits.join(" • "));
			if (user.conventions.length) lines.push(`Conventions: ${user.conventions.join(", ")}`);
		}
	}

	return lines.join("\n");
}

// ── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let projectProfile: ProjectProfile | null = null;
	let userProfile = loadUser();

	/** Get or load the project profile (reconcile if stale). */
	function getProject(cwd: string): ProjectProfile {
		if (projectProfile) return projectProfile;
		const stored = loadProject(cwd);
		// Auto-detect on first load of the session if never scanned or older than 1h
		if (!stored.lastScanned || Date.now() - stored.lastScanned > 3_600_000) {
			projectProfile = reconcile(cwd, stored);
			saveProject(cwd, projectProfile);
		} else {
			projectProfile = stored;
		}
		return projectProfile;
	}

	// ── Tools ────────────────────────────────────────────────────────────────

	pi.registerTool({
		name: "memory_status",
		label: "Memory Status",
		description: [
			"Show what pi knows about the current project and user preferences.",
			"Returns both profiles so you can see what's been auto-detected and what conventions have been saved.",
		].join(" "),
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const project = getProject(ctx.cwd);
			const user = loadUser();
			return {
				content: [{ type: "text", text: buildPromptBlock(project, user) }],
				details: { project, user },
			};
		},
	});

	pi.registerTool({
		name: "memory_project",
		label: "Memory Project",
		description: [
			"View or update project-specific memory. Call with no arguments to see the current profile.",
			"To add a convention: pass a `convention` string describing a project-specific pattern or rule.",
			"To set tech stack fields: pass `field` (packageManager, language, framework, designSystem, buildTool, testRunner, linter, formatter) and `value`.",
			"To remove a convention: pass `removeConvention` with the index (0-based).",
			"Use this when you discover a project convention that isn't auto-detected — e.g. 'uses pi.registerTool for all tools' or 'prefers functional components'.",
		].join(" "),
		parameters: Type.Object({
			convention: Type.Optional(Type.String({ description: "A project convention to add (e.g. 'uses default export factory functions')" })),
			conventions: Type.Optional(Type.Array(Type.String(), { description: "Multiple conventions to set (replaces existing)" })),
			field: Type.Optional(StringEnum(["packageManager", "language", "framework", "designSystem", "buildTool", "testRunner", "linter", "formatter"], { description: "Tech stack field to update" })),
			value: Type.Optional(Type.String({ description: "Value for the field" })),
			removeConvention: Type.Optional(Type.Number({ description: "Index of convention to remove (0-based)" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const project = getProject(ctx.cwd);

			if (params.field && params.value !== undefined) {
				(project as any)[params.field] = params.value;
			}
			if (params.conventions) {
				project.conventions = params.conventions;
			} else if (params.convention) {
				project.conventions.push(params.convention);
			}
			if (params.removeConvention !== undefined && params.removeConvention >= 0) {
				project.conventions.splice(params.removeConvention, 1);
			}

			saveProject(ctx.cwd, project);

			const lines = ["Project memory updated."];
			if (params.convention) lines.push(`Added: ${params.convention}`);
			if (params.field) lines.push(`Set ${params.field}: ${params.value}`);
			if (params.removeConvention !== undefined) lines.push("Removed convention.");

			return {
				content: [{ type: "text", text: `${lines.join("\n")}\n\n${buildPromptBlock(project, loadUser())}` }],
				details: { project },
			};
		},
	});

	pi.registerTool({
		name: "memory_user",
		label: "Memory User",
		description: [
			"View or update user-level preferences that apply across all projects.",
			"Call with no arguments to see current preferences.",
			"To set a preference: pass `field` and `value`.",
			"Fields: communication, commitStyle, indent, quotes, preferredPackageManager, errorHandling, shell.",
			"To add a convention: pass `convention` (e.g. 'prefers TypeScript over JavaScript').",
			"Use this when the user corrects you or states a preference — e.g. 'I prefer tabs' or 'always use try/catch'.",
		].join(" "),
		parameters: Type.Object({
			field: Type.Optional(StringEnum(["communication", "commitStyle", "indent", "quotes", "preferredPackageManager", "errorHandling", "shell"], { description: "Preference field to update" })),
			value: Type.Optional(Type.String({ description: "Value for the field" })),
			convention: Type.Optional(Type.String({ description: "A user convention to add (e.g. 'prefers concise variable names')" })),
			conventions: Type.Optional(Type.Array(Type.String(), { description: "Multiple conventions to set (replaces existing)" })),
			removeConvention: Type.Optional(Type.Number({ description: "Index of convention to remove (0-based)" })),
		}),
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			const user = loadUser();

			if (params.field && params.value !== undefined) {
				(user as any)[params.field] = params.value;
			}
			if (params.conventions) {
				user.conventions = params.conventions;
			} else if (params.convention) {
				user.conventions.push(params.convention);
			}
			if (params.removeConvention !== undefined && params.removeConvention >= 0) {
				user.conventions.splice(params.removeConvention, 1);
			}

			saveUser(user);
			userProfile = user;

			return {
				content: [{ type: "text", text: "User preferences updated." }],
				details: { user },
			};
		},
	});

	// ── System prompt injection ──────────────────────────────────────────────

	pi.on("before_agent_start", async (event, ctx) => {
		const project = getProject(ctx.cwd);
		const user = loadUser();
		const block = buildPromptBlock(project, user);

		return {
			systemPrompt: `${event.systemPrompt}\n\n${block}`,
		};
	});

	// ── Session lifecycle ────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		// Eager-load project profile on session start so it's ready
		getProject(ctx.cwd);
		// Auto-detect user preferences from the project
		const detected = detectUser(ctx.cwd);
		const user = loadUser();
		let changed = false;
		if (detected.commitStyle && !user.commitStyle) {
			user.commitStyle = detected.commitStyle;
			changed = true;
		}
		if (detected.indent && !user.indent) {
			user.indent = detected.indent;
			changed = true;
		}
		if (changed) saveUser(user);
		userProfile = user;
	});

	// ── Commands ─────────────────────────────────────────────────────────────

	pi.registerCommand("memory", {
		description: "Show or update project/user memory. /memory rescan to re-detect.",
		handler: async (args, ctx) => {
			const [sub, ...rest] = args.trim().split(/\s+/);
			const restStr = rest.join(" ");

			switch (sub) {
				case "": {
					const project = getProject(ctx.cwd);
					const user = loadUser();
					ctx.ui.notify(buildPromptBlock(project, user), "info");
					return;
				}
				case "rescan": {
					projectProfile = null;
					const project = getProject(ctx.cwd);
					// Merge auto-detected into stored, keeping conventions
					const fresh = detectProject(ctx.cwd);
					fresh.conventions = project.conventions;
					saveProject(ctx.cwd, fresh);
					projectProfile = fresh;
					ctx.ui.notify(`Project re-scanned: ${fresh.language ?? "?"} • ${fresh.packageManager ?? "?"} • ${fresh.framework ?? "no framework"}`, "info");
					return;
				}
				case "clear": {
					projectProfile = null;
					const fresh = detectProject(ctx.cwd);
					fresh.conventions = [];
					saveProject(ctx.cwd, fresh);
					projectProfile = fresh;
					ctx.ui.notify("Project memory cleared. Auto-detected tech stack preserved.", "info");
					return;
				}
				case "project": {
					if (!restStr.includes("=")) {
						ctx.ui.notify("Usage: /memory project <key=value>. Keys: convention, packageManager, language, framework, designSystem, buildTool, testRunner, linter, formatter", "error");
						return;
					}
					const eq = restStr.indexOf("=");
					const key = restStr.slice(0, eq).trim();
					const value = restStr.slice(eq + 1).trim();
					const project = getProject(ctx.cwd);
					if (key === "convention") {
						project.conventions.push(value);
					} else if (key in project) {
						(project as any)[key] = value;
					} else {
						ctx.ui.notify(`Unknown key: ${key}`, "error");
						return;
					}
					saveProject(ctx.cwd, project);
					ctx.ui.notify(`Project ${key} → ${value}`, "info");
					return;
				}
				case "user": {
					if (!restStr.includes("=")) {
						ctx.ui.notify("Usage: /memory user <key=value>. Keys: communication, commitStyle, indent, quotes, preferredPackageManager, errorHandling, convention", "error");
						return;
					}
					const eq = restStr.indexOf("=");
					const key = restStr.slice(0, eq).trim();
					const value = restStr.slice(eq + 1).trim();
					const user = loadUser();
					if (key === "convention") {
						user.conventions.push(value);
					} else if (key in user) {
						(user as any)[key] = value;
					} else {
						ctx.ui.notify(`Unknown key: ${key}`, "error");
						return;
					}
					saveUser(user);
					userProfile = user;
					ctx.ui.notify(`User ${key} → ${value}`, "info");
					return;
				}
				default:
					ctx.ui.notify("Usage: /memory [project key=value|user key=value|rescan|clear]", "error");
			}
		},
	});
}
