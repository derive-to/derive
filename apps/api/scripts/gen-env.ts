import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { genEnvExample } from "../src/config-manifest"

const output = join(import.meta.dirname, "../../../.env.example")
writeFileSync(output, genEnvExample())
