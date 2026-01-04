import fs from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()
const cliPath = path.join(root, 'dist', 'cli.js')
const shebang = '#!/usr/bin/env node\n'

async function main() {
  let content
  try {
    content = await fs.readFile(cliPath, 'utf8')
  } catch (e) {
    throw new Error(`postbuild-shebang: missing ${cliPath}. Did tsc output dist/cli.js?`)
  }

  if (content.startsWith(shebang)) return
  // Avoid adding before an existing shebang (e.g., #!/usr/bin/node)
  if (content.startsWith('#!')) {
    const idx = content.indexOf('\n')
    content = content.slice(idx + 1)
  }

  await fs.writeFile(cliPath, shebang + content, 'utf8')
}

main().catch((err) => {
  process.stderr.write(String(err?.stack ?? err) + '\n')
  process.exit(1)
})


