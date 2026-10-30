let areasConfigSecretId: string | null = null

export default {
  async fetch(request: Request, env: any): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname
    const method = request.method

    const authHeader = request.headers.get('Authorization') || ''
    const tokenEnviado = authHeader.replace('Bearer ', '').trim()
    const tokenInterno = await env.INTERNAL_TOKEN.get()

    if (!tokenEnviado || tokenEnviado !== tokenInterno) {
      return json({ error: 'No autorizado' }, 401)
    }

    try {
      if (path === '/areas' && method === 'GET') {
        const data = await leerTodas(env)
        return json(Object.keys(data))
      }

      const match = path.match(/^\/areas\/([^/]+)$/)

      if (match && method === 'GET') {
        const area = decodeURIComponent(match[1])
        const data = await leerTodas(env)
        if (!data[area]) return json({ error: `Área [${area}] no existe` }, 404)
        return json(normalizar(data[area], area))
      }

      const matchRename = path.match(/^\/areas\/([^/]+)\/rename$/)

      if (matchRename && method === 'POST') {
        const area = decodeURIComponent(matchRename[1])
        const body = (await request.json()) as any
        const nuevo = String(body.nuevo || '').trim()
        if (!nuevo) return json({ error: 'Falta el nuevo nombre del área' }, 422)
        if (esAreaPrincipal(area)) {
          return json({ error: 'No se pueden renombrar las áreas principales' }, 422)
        }

        const data = await leerTodas(env)
        if (!data[area]) return json({ error: `Área [${area}] no encontrada` }, 404)

        if (!mismoNombre(area, nuevo) && existeNombre(data, nuevo)) {
          return json({ error: `El área [${nuevo}] ya existe`, campo: 'area' }, 409)
        }

        const payload = construirPayload(body)
        const duplicada = buscarDuplicada(data, payload, area)
        if (duplicada) return json(errorDuplicada(duplicada), 409)

        delete data[area]
        data[nuevo] = payload
        await persistirTodas(env, data)
        return json({ message: `Área [${area}] renombrada a [${nuevo}] correctamente` })
      }

      if (match && method === 'PUT') {
        const area = decodeURIComponent(match[1])
        const body = (await request.json()) as any
        const data = await leerTodas(env)
        if (!data[area]) return json({ error: `Área [${area}] no existe` }, 404)

        const payload = construirPayload(body)
        const duplicada = buscarDuplicada(data, payload, area)
        if (duplicada) return json(errorDuplicada(duplicada), 409)

        data[area] = payload
        await persistirTodas(env, data)
        return json({ message: `Área [${area}] actualizada correctamente` })
      }

      if (path === '/areas' && method === 'POST') {
        const body = (await request.json()) as any
        const area = String(body.area || '').trim()
        if (!area) return json({ error: 'Falta el nombre del área' }, 422)

        const data = await leerTodas(env)
        if (existeNombre(data, area)) {
          return json({ error: `El área [${area}] ya existe`, campo: 'area' }, 409)
        }

        const payload = construirPayload(body)
        const duplicada = buscarDuplicada(data, payload)
        if (duplicada) return json(errorDuplicada(duplicada), 409)

        data[area] = payload
        await persistirTodas(env, data)
        return json({ message: `Área [${area}] creada correctamente` }, 201)
      }

      if (match && method === 'DELETE') {
        const area = decodeURIComponent(match[1])
        if (esAreaPrincipal(area)) {
          return json({ error: 'No se pueden eliminar las áreas principales' }, 422)
        }
        const data = await leerTodas(env)
        if (!data[area]) return json({ error: `Área [${area}] no encontrada` }, 404)
        delete data[area]
        await persistirTodas(env, data)
        return json({ message: `Área [${area}] eliminada correctamente` })
      }

      if (path === '/system-secrets' && method === 'GET') {
        return json(await listarSystemSecrets(env))
      }

      const matchSystem = path.match(/^\/system-secrets\/([^/]+)$/)

      if (matchSystem && method === 'GET') {
        const name = decodeURIComponent(matchSystem[1])
        const valor = await leerSystemSecret(env, name)
        if (valor === null) return json({ error: `Secret [${name}] no existe` }, 404)
        return json({ name, value: valor })
      }

      if (matchSystem && method === 'PUT') {
        const name = decodeURIComponent(matchSystem[1])
        const body = (await request.json()) as any
        await guardarSystemSecret(env, name, body.value)
        return json({ message: `Secret [${name}] actualizado` })
      }

      return json({ error: 'Ruta no encontrada' }, 404)
    } catch (error: any) {
      if (error instanceof ErrorValidacion) return json({ error: error.message }, 422)
      return json({ error: error.message || 'Error interno' }, 500)
    }
  },
}

const SYSTEM_SECRETS = [
  'AREAS_CONFIG',
  'CF_ACCOUNT_ID',
  'CF_STORE_ID',
  'INTERNAL_TOKEN',
  'CF_API_TOKEN',
  'AGENTE_LN1_TOKEN',
]

async function leerTodas(env: any): Promise<Record<string, any>> {
  const raw = await env.AREAS_CONFIG.get()
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

async function getAreasConfigSecretId(env: any): Promise<string> {
  if (areasConfigSecretId) return areasConfigSecretId
  const s = await buscarSecretPorNombre(env, 'AREAS_CONFIG')
  if (!s) throw new Error('Secret AREAS_CONFIG no existe en el store')
  areasConfigSecretId = s.id
  return s.id
}

async function persistirTodas(env: any, data: Record<string, any>) {
  const id = await getAreasConfigSecretId(env)
  await callCloudflare(env, 'PATCH', `/secrets/${id}`, {
    value: JSON.stringify(data),
    scopes: ['workers'],
  })
}

class ErrorValidacion extends Error {}

function esAreaPrincipal(area: string): boolean {
  return area === 'Sistemas' || area === 'Marketing'
}

function mismoNombre(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

function existeNombre(data: Record<string, any>, nombre: string): boolean {
  return Object.keys(data).some((existente) => mismoNombre(existente, nombre))
}

function normalizarHost(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/[/?#].*$/, '')
}

function construirPayload(body: any) {
  const payload = {
    host: String(body.host || '').trim(),
    email: String(body.email || '').trim(),
    token: String(body.token || '').trim(),
    sprint_field: body.sprint_field || 'customfield_10020',
    epic_link_mode: body.epic_link_mode || 'parent',
    epic_link_field: body.epic_link_field ?? null,
  }

  if (!payload.host || !payload.email || !payload.token) {
    throw new ErrorValidacion('host, email y token son obligatorios')
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) {
    throw new ErrorValidacion('El email no es válido')
  }

  return payload
}

function buscarDuplicada(
  data: Record<string, any>,
  payload: { host: string; token: string },
  excluir?: string
): string | null {
  const host = normalizarHost(payload.host)

  for (const [nombre, config] of Object.entries(data)) {
    if (excluir !== undefined && nombre === excluir) continue
    if (!config || typeof config !== 'object') continue
    if (
      normalizarHost(String(config.host || '')) === host &&
      String(config.token || '').trim() === payload.token
    ) {
      return nombre
    }
  }

  return null
}

function errorDuplicada(existente: string) {
  return {
    error: `Ya existe el área [${existente}] con el mismo host y token de Jira`,
    campo: 'token',
  }
}

function normalizar(config: any, area: string) {
  return {
    area,
    host: config.host,
    email: config.email,
    token: config.token,
    sprint_field: config.sprint_field || 'customfield_10020',
    epic_link_mode: config.epic_link_mode || 'parent',
    epic_link_field: config.epic_link_field ?? null,
  }
}

async function listarSystemSecrets(env: any) {
  const resultado = []
  for (const name of SYSTEM_SECRETS) {
    const binding = env[name]
    if (binding && typeof binding.get === 'function') {
      await binding.get()
      resultado.push({ name, value: '••••••••••••••••', is_sensitive: true })
    }
  }
  return resultado
}

async function leerSystemSecret(env: any, name: string) {
  if (!SYSTEM_SECRETS.includes(name)) return null
  const binding = env[name]
  if (!binding || typeof binding.get !== 'function') return null
  return await binding.get()
}

async function guardarSystemSecret(env: any, name: string, value: string) {
  if (!SYSTEM_SECRETS.includes(name)) throw new Error(`Secret [${name}] no permitido`)
  if (!value || !String(value).trim()) throw new Error('El valor no puede estar vacío')

  const existente = await buscarSecretPorNombre(env, name)
  if (!existente) throw new Error(`Secret [${name}] no existe`)

  await callCloudflare(env, 'PATCH', `/secrets/${existente.id}`, {
    value: String(value).trim(),
    scopes: ['workers'],
  })
}

async function buscarSecretPorNombre(env: any, nombre: string) {
  const res = await callCloudflare(env, 'GET', '/secrets')
  const lista = res?.result || []
  return lista.find((s: any) => s.name === nombre) || null
}

async function callCloudflare(env: any, method: string, path: string, body?: any) {
  const accountId = await env.CF_ACCOUNT_ID.get()
  const token = await env.CF_API_TOKEN.get()
  const storeId = await env.CF_STORE_ID.get()
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/secrets_store/stores/${storeId}${path}`

  const options: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  }
  if (body !== undefined) options.body = JSON.stringify(body)

  const res = await fetch(url, options)
  const data: any = await res.json()
  if (!res.ok || data.success === false) {
    throw new Error(data?.errors?.[0]?.message || `Error Cloudflare ${res.status}`)
  }
  return data
}

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}