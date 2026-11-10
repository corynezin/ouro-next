// The part of the Sprites API (https://docs.sprites.dev/api) the Sprite provisioner uses, and its HTTP client.
// Nothing here reads a command's output from exec: the HTTP form's framing relies on chunk boundaries surviving
// proxies, so commands write their results to files that are read back with the filesystem API.
//
// The organisation's token reaches every Sprite in it, the hub's own and others alike. So the client is scoped to one
// name prefix: it names, lists and touches only Sprites whose names start with it, and refuses any other name.

export type SpriteUrlAuth = 'sprite' | 'public'

export interface SpriteInfo {
  name: string
  /** Where the Sprite's HTTP port is reached. */
  url: string
  urlAuth: SpriteUrlAuth
}

/**
 * Lowercase words joined and ended by hyphens, such as `ouro-next-h-`. The final hyphen keeps one prefix from covering
 * another's Sprites: `ouro-next-h-` is not a prefix of `ouro-next-hub-…`.
 */
const NAME_PREFIX = /^[a-z0-9]+(-[a-z0-9]+)*-$/

/** Why a Sprite name prefix can't be used, or null if it can. */
export const namePrefixProblem = (prefix: string): string | null =>
  NAME_PREFIX.test(prefix) ? null : `the Sprite name prefix ${JSON.stringify(prefix)} must be lowercase words joined and ended by hyphens, such as "ouro-next-h-"`

export class SpriteNameOutOfScope extends Error {}

export interface SpritesApi {
  /** Every Sprite this API names or touches has a name starting with this. */
  readonly namePrefix: string
  /** The names of the organisation's Sprites that start with `namePrefix`. */
  listSpriteNames(): Promise<string[]>
  /** Null when the organisation has no Sprite of that name. */
  getSprite(name: string): Promise<SpriteInfo | null>
  /** A new Sprite whose URL anyone can reach: phones pair with it, and the server checks every request itself. */
  createSprite(name: string): Promise<SpriteInfo>
  makeUrlPublic(name: string): Promise<SpriteInfo>
  writeFile(name: string, path: string, content: Buffer, mode: string): Promise<void>
  /** Null when there is no such file. */
  readFile(name: string, path: string): Promise<Buffer | null>
  /** The Sprite and all it holds are gone; a Sprite that doesn't exist is as good. Throws `SpriteNameOutOfScope` for one that isn't the hub's. */
  deleteSprite(name: string): Promise<void>
  /** Runs a command and settles when it ends; its output and exit status are not read. */
  exec(name: string, argv: string[]): Promise<void>
}

export class SpritesApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

interface SpriteResponse {
  name: string
  url: string
  url_settings: { auth: SpriteUrlAuth } | null
}

const spriteInfoOf = (sprite: SpriteResponse): SpriteInfo => ({ name: sprite.name, url: sprite.url, urlAuth: sprite.url_settings?.auth ?? 'sprite' })

export const SPRITES_API_BASE = 'https://api.sprites.dev'

/** Sprites listed per request. */
const LIST_PAGE_SIZE = 50

interface SpriteListResponse {
  sprites: { name: string }[] | null
  has_more: boolean | null
  next_continuation_token: string | null
}

export class SpritesHttpApi implements SpritesApi {
  readonly namePrefix: string
  private readonly base: string
  private readonly token: string

  constructor(token: string, namePrefix: string, base = SPRITES_API_BASE) {
    const problem = namePrefixProblem(namePrefix)
    if (problem) throw new SpriteNameOutOfScope(problem)
    this.token = token
    this.namePrefix = namePrefix
    this.base = base
  }

  async listSpriteNames(): Promise<string[]> {
    const names: string[] = []
    let continuation: string | null = null
    do {
      const query = new URLSearchParams({ prefix: this.namePrefix, max_results: String(LIST_PAGE_SIZE) })
      if (continuation) query.set('continuation_token', continuation)
      const page = await (await this.call('GET', `/v1/sprites?${query}`, {}))!.json() as SpriteListResponse
      names.push(...(page.sprites ?? []).map((sprite) => sprite.name))
      continuation = page.has_more ? page.next_continuation_token : null
    } while (continuation)
    // The prefix is the API's filter too, but what counts against the hub's limit is decided here.
    return names.filter((name) => name.startsWith(this.namePrefix))
  }

  async getSprite(name: string): Promise<SpriteInfo | null> {
    const response = await this.call('GET', this.spritePath(name), { allowNotFound: true })
    return response ? spriteInfoOf(await response.json() as SpriteResponse) : null
  }

  async createSprite(name: string): Promise<SpriteInfo> {
    const response = await this.call('POST', '/v1/sprites', { json: { name: this.inScope(name), url_settings: { auth: 'public' } } })
    return spriteInfoOf(await response!.json() as SpriteResponse)
  }

  async makeUrlPublic(name: string): Promise<SpriteInfo> {
    const response = await this.call('PUT', this.spritePath(name), { json: { url_settings: { auth: 'public' } } })
    return spriteInfoOf(await response!.json() as SpriteResponse)
  }

  async writeFile(name: string, path: string, content: Buffer, mode: string): Promise<void> {
    const query = new URLSearchParams({ path, workingDir: '/', mode, mkdir: 'true' })
    const response = await this.call('PUT', `${this.spritePath(name)}/fs/write?${query}`, { bytes: content })
    await response!.arrayBuffer()
  }

  async readFile(name: string, path: string): Promise<Buffer | null> {
    const query = new URLSearchParams({ path, workingDir: '/' })
    const response = await this.call('GET', `${this.spritePath(name)}/fs/read?${query}`, { allowNotFound: true })
    return response ? Buffer.from(await response.arrayBuffer()) : null
  }

  async deleteSprite(name: string): Promise<void> {
    const response = await this.call('DELETE', this.spritePath(name), { allowNotFound: true })
    await response?.arrayBuffer()
  }

  async exec(name: string, argv: string[]): Promise<void> {
    const query = new URLSearchParams()
    for (const arg of argv) query.append('cmd', arg)
    query.set('path', argv[0]!)
    const response = await this.call('POST', `${this.spritePath(name)}/exec?${query}`, {})
    // The body ends when the command does.
    await response!.arrayBuffer()
  }

  /** The name, if it is one of this hub's. */
  private inScope(name: string): string {
    if (!name.startsWith(this.namePrefix) || name.length === this.namePrefix.length) throw new SpriteNameOutOfScope(`the Sprite ${JSON.stringify(name)} is not one of this hub's, which start with ${JSON.stringify(this.namePrefix)}`)
    return name
  }

  private spritePath(name: string): string {
    return `/v1/sprites/${encodeURIComponent(this.inScope(name))}`
  }

  private async call(method: string, path: string, options: { json?: object; bytes?: Buffer; allowNotFound?: boolean }): Promise<Response | null> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}` }
    let body: string | Uint8Array | undefined
    if (options.json) {
      headers['content-type'] = 'application/json'
      body = JSON.stringify(options.json)
    } else if (options.bytes) {
      headers['content-type'] = 'application/octet-stream'
      body = options.bytes
    }
    const response = await fetch(`${this.base}${path}`, { method, headers, body, signal: AbortSignal.timeout(120_000) })
    if (response.status === 404 && options.allowNotFound) {
      await response.arrayBuffer()
      return null
    }
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500)
      throw new SpritesApiError(response.status, `the Sprites API answered ${method} ${path.split('?')[0]} with ${response.status}: ${detail}`)
    }
    return response
  }
}
