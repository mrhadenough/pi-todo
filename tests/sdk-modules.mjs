import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Resolve from the host package, supporting both nested and npm-hoisted layouts.
export function hostModuleUrl(piDir, name) {
  return pathToFileURL(createRequire(resolve(piDir, "package.json")).resolve(name));
}
