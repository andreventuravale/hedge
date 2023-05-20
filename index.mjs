#!/usr/bin/env node

import minimist from 'minimist'
import { execSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import process from 'node:process'

const { scope } = minimist(process.argv)

const makeJsonFile = await makeFile(
  'utf8',
  async raw => JSON.parse(raw),
  async parsed => JSON.stringify(parsed, null, 2)
)

const text = await shell()`find . | grep package.json | grep -v node_modules`

const paths = text.trim().split(/[\r\n]/g)

for await (const path of paths) {
  const pkg = makeJsonFile(path)

  const name = await pkg.get(({ name }) => name)

  if (name.startsWith(scope)) {
    console.log('Linking:', path, `( ${name} )`)

    await shell({ cwd: dirname(path), stdio: 'inherit', shell: true })`npm link`
  }
}

for await (const path of paths) {
  const pkg = makeJsonFile(path)

  const deps = await pkg.get(({ dependencies }) => dependencies)

  console.log(deps)

  // if (name.startsWith(scope)) {
  //   await shell({ cwd: dirname(path) })`npm link`
  // }
}

async function fileExists (path) {
  try {
    await stat(path)

    return true
  } catch {
    return false
  }
}

async function makeFile (options, parse, serialize) {
  return path => {
    let content = null

    const getContent = async () => {
      if (content === null) {
        content = await parse(
          await readFile(path, options)
        )
      }

      return content
    }

    return {
      get dir () { return dirname(path) },

      get path () { return path },

      async get (action) {
        if (!action) {
          return await getContent()
        }

        return await action(
          await getContent()
        )
      },

      async invalidate () {
        content = null
      },

      async modify (action) {
        await action(
          await getContent()
        )
      },

      async save () {
        await writeFile(
          path,
          await serialize(
            await getContent()
          ),
          options
        )

        await this.invalidate()
      }
    }
  }
}

function shell (options) {
  return function (tpl = [], ...args) {
    return new Promise((resolve, reject) => {
      const tplParts = tpl.slice(0)
      const argParts = args.slice(0)
      const script = []

      while (tplParts.length > 0 || argParts.length > 0) {
        script.push(
          tplParts.shift() ?? '',
          argParts.shift() ?? ''
        )
      }

      const cmd = script.join('')

      const data = execSync(cmd, options)

      resolve(data?.toString('utf8'))
    })
  }
}
