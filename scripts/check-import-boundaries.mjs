import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { parse } from "@babel/parser";

const repositoryRoot = process.cwd();
const sourceFiles = [
  ...(await collectSourceFiles(path.join(repositoryRoot, "src"))),
  ...(await collectSourceFiles(path.join(repositoryRoot, "worker"))),
];
const forbiddenLayerImports = new Map([
  ["agent", new Set(["application", "client", "server"])],
  ["application", new Set(["client", "server"])],
  ["client", new Set(["agent", "application", "runtime", "server"])],
  ["domain", new Set(["agent", "application", "client", "runtime", "server"])],
  ["runtime", new Set(["agent", "application", "client", "server"])],
  ["server", new Set(["client"])],
  ["shared", new Set(["agent", "application", "client", "domain", "runtime", "server"])],
]);
const violations = [];

for (const file of sourceFiles) {
  const sourceRelative = toRepositoryPath(file);
  const sourceLayer = getLayer(sourceRelative);
  if (!sourceLayer) {
    continue;
  }

  const content = await readFile(file, "utf8");
  const imports = collectModuleSpecifiers(
    parse(content, {
      plugins: parserPlugins(file),
      sourceFilename: sourceRelative,
      sourceType: "module",
    }),
  );

  for (const specifier of imports) {
    if (!specifier.startsWith(".")) {
      if (sourceLayer === "domain" && !isTestFile(sourceRelative)) {
        violations.push(
          `${sourceRelative}: domain production code cannot import package "${specifier}"`,
        );
      }
      continue;
    }

    const targetRelative = toRepositoryPath(path.resolve(path.dirname(file), specifier));
    const targetLayer = getLayer(targetRelative);
    if (!targetLayer) {
      continue;
    }

    if (forbiddenLayerImports.get(sourceLayer)?.has(targetLayer)) {
      violations.push(
        `${sourceRelative}: ${sourceLayer} cannot import ${targetLayer} (${specifier})`,
      );
      continue;
    }

    if (
      sourceLayer === "agent" &&
      targetLayer === "runtime" &&
      stripExtension(targetRelative) !== "src/runtime/contract"
    ) {
      violations.push(
        `${sourceRelative}: agent code may import only the generic runtime contract (${specifier})`,
      );
    }

    if (
      sourceLayer === "application" &&
      targetLayer === "runtime" &&
      !isTestFile(sourceRelative) &&
      stripExtension(targetRelative) !== "src/runtime/contract"
    ) {
      violations.push(
        `${sourceRelative}: application code may import only the generic runtime contract (${specifier})`,
      );
    }

    if (sourceLayer === "worker" && targetLayer !== "server") {
      violations.push(
        `${sourceRelative}: the Worker entrypoint may import only the server boundary (${specifier})`,
      );
    }
  }
}

if (violations.length > 0) {
  console.error("Import boundary check failed:");
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exitCode = 1;
} else {
  console.log(`Import boundary check passed (${sourceFiles.length} source files).`);
}

async function collectSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectSourceFiles(entryPath)));
    } else if (/\.[cm]?[jt]sx?$/u.test(entry.name)) {
      files.push(entryPath);
    }
  }

  return files;
}

function getLayer(relativePath) {
  const match = /^(?:src\/([^/]+)|worker)(?:\/|$)/u.exec(relativePath);
  return match?.[1] ?? (relativePath.startsWith("worker/") ? "worker" : null);
}

function collectModuleSpecifiers(ast) {
  const specifiers = new Set();
  const stack = [ast.program];

  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node !== "object") {
      continue;
    }
    if (Array.isArray(node)) {
      stack.push(...node);
      continue;
    }

    if (
      (node.type === "ImportDeclaration" ||
        node.type === "ExportAllDeclaration" ||
        node.type === "ExportNamedDeclaration") &&
      node.source?.type === "StringLiteral"
    ) {
      specifiers.add(node.source.value);
    } else if (node.type === "ImportExpression" && node.source?.type === "StringLiteral") {
      specifiers.add(node.source.value);
    } else if (
      node.type === "CallExpression" &&
      node.callee?.type === "Import" &&
      node.arguments?.[0]?.type === "StringLiteral"
    ) {
      specifiers.add(node.arguments[0].value);
    } else if (
      node.type === "CallExpression" &&
      node.callee?.type === "Identifier" &&
      node.callee.name === "require" &&
      node.arguments?.[0]?.type === "StringLiteral"
    ) {
      specifiers.add(node.arguments[0].value);
    }

    for (const [key, value] of Object.entries(node)) {
      if (key !== "loc" && key !== "start" && key !== "end" && key !== "extra") {
        stack.push(value);
      }
    }
  }

  return specifiers;
}

function isTestFile(relativePath) {
  return /\.(?:e2e\.)?test\.[cm]?[jt]sx?$/u.test(relativePath);
}

function parserPlugins(file) {
  const plugins = [];
  if (/\.[cm]?tsx?$/u.test(file)) {
    plugins.push("typescript");
  }
  if (/\.[jt]sx$/u.test(file)) {
    plugins.push("jsx");
  }
  return plugins;
}

function stripExtension(relativePath) {
  return relativePath.replace(/\.[cm]?[jt]sx?$/u, "");
}

function toRepositoryPath(absolutePath) {
  return path.relative(repositoryRoot, absolutePath).split(path.sep).join("/");
}
