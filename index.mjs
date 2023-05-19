#!/usr/bin/env node

import { get, unset } from 'lodash-es'
import minimist from 'minimist'
import { spawn } from 'node:child_process'
import { promises as fsPromises } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { parse, stringify } from 'yaml'
import yn from 'yn'
import sortKeys from 'sort-keys'

const { readFile, stat, writeFile } = fsPromises

let { root: optRoot, config: optConfig, 'fill-gaps': optFillGaps } = minimist(process.argv)

if (!optRoot) {
  optRoot = '.'
}

const originalDir = process.cwd()

if (!optConfig) {
  optConfig = './bush.yaml'
}

const wpath = resolve(optRoot)

const configYaml = await readFile(optConfig, 'utf8')

const config = parse(configYaml, {
  reviver: (key, value) => value ?? ''
})

const jsonFile = await makeFile(
  'utf8',
  async raw => JSON.parse(raw),
  async parsed => JSON.stringify(parsed, null, 2)
)

const rootPkg = jsonFile(
  join(wpath, 'package.json')
)

await rootPkg.modify(async content => {
  content.name = config.name
})

await rootPkg.save()

await assignDeps(config, rootPkg, config.root?.attributes?.references)

for await (const [wname, wnode] of Object.entries(config.workspaces)) {
  await shell({ cwd: wpath })`mkdir -p ${wname}`

  await visitNodes({ config, wname, wnode, packageNodes: wnode.tree, wpath, path: '' })
}

await shell({ cwd: optRoot })`${config.manager} install`

function shell ({ cwd = process.cwd() }) {
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

      console.log('$', cmd)

      const proc = spawn(cmd, { cwd, stdio: 'inherit', shell: true })

      let error

      proc.on('error', error_ => {
        error = error_
      })

      proc.on('close', code => {
        if (code === 0) {
          resolve()
        } else {
          reject(error)
        }
      })
    })
  }
}

async function assignDeps (config, pkg, refs) {
  for await (
    const [
      ref,
      {
        'is-dev': isDevLocal = 'no',
        'save-peer': savePeer = 'no'
      } = {}
    ] of Object.entries(refs ?? {})
  ) {
    const isDevGlobal = config.references?.[ref]?.['is-dev']

    const isDev = isDevLocal ?? isDevGlobal ?? 'no'

    const prop = isDev || savePeer ? 'devDependencies' : 'dependencies'

    const name = unescapePackageName(ref)

    await pkg.modify(async content => {
      content[prop] = content[prop] ?? {}

      content[prop][name] = `${config.references?.[name]?.version ?? 'latest'}`

      if (savePeer) {
        content.peerDependencies = content.peerDependencies ?? {}

        content.peerDependencies[name] = `${config.references?.[name]?.version ?? 'latest'}`
      }
    })

    await pkg.save()
  }
}

function unescapePackageName (name) {
  return name.replace('\\@', '@')
}

async function visitNodes ({ config, wname, wnode, packageNodes, wpath, path }) {
  for await (const [palias, packageNode] of Object.entries(packageNodes ?? {})) {
    await visitNode({ config, wname, wnode, palias, packageNode, wpath, path })
  }
}

async function visitNode ({ config, wname, wnode, palias, packageNode, wpath, path }) {
  const flat = yn(wnode.flat)

  const fspath = [path, palias].join('/').split('.').filter(Boolean).join('/')

  const apath = [path, palias].filter(Boolean).join('.')

  const pkgName = getPkgName(wnode, wnode.names[apath])

  const children = get(wnode?.tree, apath) ?? {}

  try {
    if (wnode.names[apath]) {
      const pkgDir = join(wpath, wname, flat ? pkgName : fspath)

      const pkgJsonPath = join(pkgDir, 'package.json')

      const refs = get(wnode?.references, apath) ?? {}

      await shell({ cwd: join(wpath, wname) })`mkdir -p ${pkgDir}`

      if (!await fileExists(pkgJsonPath)) {
        const tmpl = JSON.parse(config.template)

        tmpl.name = `@${wnode.scope}/${pkgName}`

        await writeFile(
          pkgJsonPath,
          JSON.stringify(tmpl, null, 2),
          'utf8'
        )
      }

      const pkg = await jsonFile(pkgJsonPath)

      await pkg.modify(async content => {
        content.name = `@${wnode.scope}/${pkgName}`
        unset(content, 'dependencies')
        unset(content, 'devDependencies')
        unset(content, 'peerDependencies')
      })

      for await (const [rpath] of Object.entries(refs)) {
        const rpkgName = getPkgName(wnode, wnode?.names[rpath])

        await pkg.modify(async content => {
          content.dependencies = content.dependencies ?? {}

          content.dependencies[`@${wnode.scope}/${rpkgName}`] = `${config.protocol}${`@${wnode.scope}/${rpkgName}`}`
        })

        console.log('->', rpath)
      }

      await pkg.save()

      console.group(`[${palias}]`, ':', await pkg.get(({ name }) => name) ?? '?')

      const attributesList = Object
        .entries(wnode?.attributes ?? {})
        .filter(([pattern]) => apath && new RegExp(pattern, 'gim').test(apath))
        .map(([, attributes]) => attributes)

      for await (const attributes of attributesList) {
        await assignDeps(config, pkg, attributes.references, apath)
      }

      await pkg.modify(async content => {
        if (content.dependencies) { content.dependencies = sortKeys(content.dependencies) }
        if (content.devDependencies) { content.devDependencies = sortKeys(content.devDependencies) }
        if (content.peerDependencies) { content.peerDependencies = sortKeys(content.peerDependencies) }
      })

      await pkg.save()
    } else if (optFillGaps) {
      if (Object.entries(children).length === 0) {
        wnode.names[apath] = ''

        await writeFile(join(originalDir, optConfig), stringify(config, { nullStr: '' }), 'utf8')
      }
    } else {
      console.group(`[${palias}]`)
    }

    await visitNodes({ config, wname, wnode, packageNodes: packageNode, wpath, path: apath })
  } finally {
    console.groupEnd()
  }
}

function getPkgName (wnode, name) {
  return [wnode.prefix, name].filter(Boolean).join('-')
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

export async function fileExists (path) {
  try {
    await stat(path)

    return true
  } catch {
    return false
  }
}
