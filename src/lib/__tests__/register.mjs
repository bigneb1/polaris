// Installs the resolver above for the whole test process.
import { register } from "node:module";
register("./ts-resolve.mjs", import.meta.url);
