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

      if (match && method === 'PUT') {
        const area = decodeURIComponent(match[1])
        const body = (await request.json()) as any
        await upsertArea(env, area, body)
        return json({ message: `Área [${area}] actualizada correctamente` })
      }

      if (path === '/areas' && method === 'POST') {
        const body = (await request.json()) as any
        const area = (body.area || '').trim()
        if (!area) return json({ error: 'Falta el nombre del área' }, 422)

        const data = await leerTodas(env)
        if (data[area]) return json({ error: `El área [${area}] ya existe` }, 409)

        await upsertArea(env, area, body)
        return json({ message: `Área [${area}] creada correctamente` }, 201)
      }

      if (match && method === 'DELETE') {
        const area = decodeURIComponent(match[1])
        if (area === 'Sistemas' || area === 'Marketing') {
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

async function upsertArea(env: any, area: string, body: any) {
  const payload = {
    host: (body.host || '').trim(),
    email: (body.email || '').trim(),
    token: (body.token || '').trim(),
    sprint_field: body.sprint_field || 'customfield_10020',
    epic_link_mode: body.epic_link_mode || 'parent',
    epic_link_field: body.epic_link_field ?? null,
  }

  if (!payload.host || !payload.email || !payload.token) {
    throw new Error('host, email y token son obligatorios')
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) {
    throw new Error('El email no es válido')
  }

  const data = await leerTodas(env)
  data[area] = payload
  await persistirTodas(env, data)
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