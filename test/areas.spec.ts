import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../src/index'

type Areas = Record<string, any>

function crearEntorno(inicial: Areas) {
  const estado = { areas: JSON.stringify(inicial) }

  const env = {
    INTERNAL_TOKEN: { get: async () => 'interno' },
    AREAS_CONFIG: { get: async () => estado.areas },
    CF_ACCOUNT_ID: { get: async () => 'cuenta' },
    CF_API_TOKEN: { get: async () => 'token-cf' },
    CF_STORE_ID: { get: async () => 'store' },
  }

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const metodo = init.method
      if (metodo === 'GET' && String(url).endsWith('/secrets')) {
        return new Response(JSON.stringify({ success: true, result: [{ id: 'sid', name: 'AREAS_CONFIG' }] }))
      }
      if (metodo === 'PATCH') {
        estado.areas = JSON.parse(String(init.body)).value
        return new Response(JSON.stringify({ success: true }))
      }
      return new Response(JSON.stringify({ success: false }), { status: 500 })
    })
  )

  return { env, leer: (): Areas => JSON.parse(estado.areas) }
}

function llamar(env: any, metodo: string, ruta: string, cuerpo?: unknown, token = 'interno') {
  return worker.fetch(
    new Request(`https://worker.test${ruta}`, {
      method: metodo,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
    }),
    env
  )
}

const sistemas = { host: 'sis.atlassian.net', email: 'a@x.com', token: 'tok-sis', sprint_field: 'customfield_10020', epic_link_mode: 'parent', epic_link_field: null }
const marketing = { host: 'mkt.atlassian.net', email: 'b@x.com', token: 'tok-mkt', sprint_field: 'customfield_10020', epic_link_mode: 'parent', epic_link_field: null }
const ventas = { host: 'ven.atlassian.net', email: 'c@x.com', token: 'tok-ven', sprint_field: 'customfield_10020', epic_link_mode: 'parent', epic_link_field: null }

describe('áreas del worker', () => {
  let entorno: ReturnType<typeof crearEntorno>

  beforeEach(() => {
    entorno = crearEntorno({ Sistemas: sistemas, Marketing: marketing, Ventas: ventas })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('rechaza peticiones sin token interno', async () => {
    const r = await llamar(entorno.env, 'GET', '/areas', undefined, 'otro')
    expect(r.status).toBe(401)
  })

  it('crea un área nueva', async () => {
    const r = await llamar(entorno.env, 'POST', '/areas', {
      area: 'Soporte', host: 'sop.atlassian.net', email: 'd@x.com', token: 'tok-sop',
    })
    expect(r.status).toBe(201)
    expect(Object.keys(entorno.leer())).toContain('Soporte')
  })

  it('no crea un área con el mismo host y token que otra', async () => {
    const r = await llamar(entorno.env, 'POST', '/areas', {
      area: 'Copia', host: 'https://SIS.atlassian.net/', email: 'z@x.com', token: 'tok-sis',
    })
    expect(r.status).toBe(409)
    const cuerpo: any = await r.json()
    expect(cuerpo.campo).toBe('token')
    expect(Object.keys(entorno.leer())).not.toContain('Copia')
  })

  it('permite el mismo host con otro token', async () => {
    const r = await llamar(entorno.env, 'POST', '/areas', {
      area: 'Otra', host: 'sis.atlassian.net', email: 'z@x.com', token: 'otro-token',
    })
    expect(r.status).toBe(201)
  })

  it('no crea un área con un nombre repetido sin importar mayúsculas', async () => {
    const r = await llamar(entorno.env, 'POST', '/areas', {
      area: 'marketing', host: 'nuevo.atlassian.net', email: 'z@x.com', token: 'tok-nuevo',
    })
    expect(r.status).toBe(409)
    const cuerpo: any = await r.json()
    expect(cuerpo.campo).toBe('area')
  })

  it('editar un área inexistente no la crea', async () => {
    const r = await llamar(entorno.env, 'PUT', '/areas/Fantasma', {
      host: 'f.atlassian.net', email: 'f@x.com', token: 'tok-f',
    })
    expect(r.status).toBe(404)
    expect(Object.keys(entorno.leer())).not.toContain('Fantasma')
  })

  it('editar un área con sus mismos datos no cuenta como duplicado', async () => {
    const r = await llamar(entorno.env, 'PUT', '/areas/Ventas', ventas)
    expect(r.status).toBe(200)
  })

  it('editar un área con host y token de otra da error', async () => {
    const r = await llamar(entorno.env, 'PUT', '/areas/Ventas', marketing)
    expect(r.status).toBe(409)
    expect(entorno.leer().Ventas.host).toBe('ven.atlassian.net')
  })

  it('renombra un área conservando host y token', async () => {
    const r = await llamar(entorno.env, 'POST', '/areas/Ventas/rename', { nuevo: 'Comercial', ...ventas })
    expect(r.status).toBe(200)
    const areas = entorno.leer()
    expect(areas.Ventas).toBeUndefined()
    expect(areas.Comercial.host).toBe('ven.atlassian.net')
    expect(areas.Comercial.token).toBe('tok-ven')
  })

  it('renombrar no lo toma como duplicado de sí mismo', async () => {
    const r = await llamar(entorno.env, 'POST', '/areas/Ventas/rename', { nuevo: 'VENTAS', ...ventas })
    expect(r.status).toBe(200)
    expect(Object.keys(entorno.leer())).toContain('VENTAS')
  })

  it('no renombra sobre un nombre existente', async () => {
    const r = await llamar(entorno.env, 'POST', '/areas/Ventas/rename', { nuevo: 'marketing', ...ventas })
    expect(r.status).toBe(409)
    expect(Object.keys(entorno.leer())).toContain('Ventas')
  })

  it('no renombra las áreas principales', async () => {
    const r = await llamar(entorno.env, 'POST', '/areas/Sistemas/rename', { nuevo: 'IT', ...sistemas })
    expect(r.status).toBe(422)
  })

  it('renombrar con credenciales de otra área da error', async () => {
    const r = await llamar(entorno.env, 'POST', '/areas/Ventas/rename', { nuevo: 'Comercial', ...marketing })
    expect(r.status).toBe(409)
    expect(Object.keys(entorno.leer())).toContain('Ventas')
  })

  it('elimina un área no principal y protege las principales', async () => {
    const ok = await llamar(entorno.env, 'DELETE', '/areas/Ventas')
    expect(ok.status).toBe(200)
    expect(Object.keys(entorno.leer())).not.toContain('Ventas')

    const protegida = await llamar(entorno.env, 'DELETE', '/areas/Marketing')
    expect(protegida.status).toBe(422)
  })

  it('responde 422 cuando faltan datos obligatorios', async () => {
    const r = await llamar(entorno.env, 'POST', '/areas', { area: 'Incompleta', host: 'x.atlassian.net' })
    expect(r.status).toBe(422)
  })

  it('renombrar el mismo área muchas veces seguidas no la elimina ni toca las demás', async () => {
    let actual = 'Arquitectura'
    entorno = crearEntorno({ Sistemas: sistemas, Marketing: marketing, Arquitectura: ventas })

    for (let i = 1; i <= 20; i++) {
      const nuevo = `Area ${i}`
      const r = await llamar(entorno.env, 'POST', `/areas/${encodeURIComponent(actual)}/rename`, { ...ventas, nuevo })
      expect(r.status).toBe(200)
      actual = nuevo
      const datos = entorno.leer()
      expect(Object.keys(datos).sort()).toEqual(['Area ' + i, 'Marketing', 'Sistemas'].sort())
      expect(datos[actual].host).toBe(ventas.host)
      expect(datos[actual].token).toBe(ventas.token)
    }

    expect(entorno.leer().Sistemas.token).toBe(sistemas.token)
    expect(entorno.leer().Marketing.token).toBe(marketing.token)
  })

  it('volver a un nombre anterior funciona', async () => {
    entorno = crearEntorno({ Sistemas: sistemas, Marketing: marketing, A: ventas })
    for (const [de, a] of [['A', 'B'], ['B', 'A'], ['A', 'B'], ['B', 'A']]) {
      const r = await llamar(entorno.env, 'POST', `/areas/${de}/rename`, { ...ventas, nuevo: a })
      expect(r.status).toBe(200)
    }
    expect(Object.keys(entorno.leer()).sort()).toEqual(['A', 'Marketing', 'Sistemas'])
  })

  it('con lectura vieja del store el segundo renombrado se rechaza y no pierde nada', async () => {
    const e = crearEntorno({ Sistemas: sistemas, Marketing: marketing, A: ventas })
    const viejo = JSON.stringify({ Sistemas: sistemas, Marketing: marketing, A: ventas })
    e.env.AREAS_CONFIG.get = async () => viejo
    const r1 = await llamar(e.env, 'POST', '/areas/A/rename', { ...ventas, nuevo: 'B' })
    expect(r1.status).toBe(200)
    const r2 = await llamar(e.env, 'POST', '/areas/B/rename', { ...ventas, nuevo: 'C' })
    expect(r2.status).toBe(404)
    expect(Object.keys(e.leer()).sort()).toEqual(['B', 'Marketing', 'Sistemas'])
  })
})
