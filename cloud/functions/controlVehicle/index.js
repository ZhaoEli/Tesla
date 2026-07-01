/**
 * 云函数：车辆控制
 * 调用 Fleet API Vehicle Command Protocol (post-2023-10):
 *   POST /api/1/vehicles/{vin}/command/{command}
 *
 * 支持的命令：
 *   lock, unlock, climate_on, climate_off, sentry_on, sentry_off,
 *   window_vent, window_close, charge_port_open, charge_port_close,
 *   trunk_open, honk_horn, flash_lights, charge_start, charge_stop
 *
 * 调用方式：
 *   wx.cloud.callFunction({ name: 'controlVehicle', data: { openid, vehicleId, command, params } })
 *
 * 返回：
 *   { code: 0, result: true/false, message: '...' }
 *   或 { code: -2, needAuth: true } 需要重新授权
 */
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

const https = require('https')

// 内联密钥配置，与 teslaAuth 云函数保持一致
const TESLA_CLIENT_ID = '3c92b641-0a9f-40d2-adea-5cad6eb0a70f'
const TESLA_CLIENT_SECRET = 'ta-secret.ql%kwzB!OC_KL-Is'
const FLEET_API_BASE = 'https://fleet-api.prd.cn.vn.cloud.tesla.cn'

// 命令映射
const COMMAND_MAP = {
  lock: 'door_lock',
  unlock: 'door_unlock',
  climate_on: 'climate_on',
  climate_off: 'climate_off',
  sentry_on: 'sentry_on',
  sentry_off: 'sentry_off',
  window_vent: 'window_vent',
  window_close: 'window_close',
  charge_port_open: 'charge_port_door_open',
  charge_port_close: 'charge_port_door_close',
  trunk_open: 'trunk_open',
  honk_horn: 'honk_horn',
  flash_lights: 'flash_lights',
  charge_start: 'charge_start',
  charge_stop: 'charge_stop',
  wake_up: 'wake_up'
}

exports.main = async (event, context) => {
  let { openid, vehicleId, command, params, checkOnline } = event

  // 轻量在线状态检查（不发送命令，只查 vehicles 列表获取 state）
  if (checkOnline) {
    try {
      if (!openid) {
        const wxContext = cloud.getWXContext()
        openid = wxContext.OPENID
      }
      const userRes = await db.collection('users').where({ openid }).get()
      if (!userRes.data?.length) return { code: -1, message: '用户不存在' }
      const user = userRes.data[0]
      let accessToken = user.teslaAccessToken
      if (!accessToken) return { code: -2, needAuth: true }

      // 刷新 token（如有需要）
      if (user.teslaTokenExpiresAt && user.teslaTokenExpiresAt < Date.now() && user.teslaRefreshToken) {
        try {
          const refreshRes = await refreshAccessToken(user.teslaRefreshToken)
          accessToken = refreshRes.access_token
          await db.collection('users').where({ openid }).update({
            data: {
              teslaAccessToken: accessToken,
              teslaTokenExpiresAt: Date.now() + (refreshRes.expires_in || 28800) * 1000,
              gmt_modified: db.serverDate()
            }
          })
        } catch (e) { /* ignore */ }
      }

      const listRes = await httpsGet(FLEET_API_BASE + '/api/1/vehicles', accessToken)
      const vehicles = listRes?.response || []
      if (vehicles.length === 0) return { code: -4, message: '无车辆' }
      const v = vehicles[0]
      return {
        code: 0,
        state: v.state || 'unknown',
        vehicleId: v.id_s,
        vin: v.vin
      }
    } catch (err) {
      return { code: -1, message: '状态检查失败', statusCode: err.statusCode, error: err.message }
    }
  }

  if (!openid) {
    const wxContext = cloud.getWXContext()
    openid = wxContext.OPENID
  }

  if (!command) {
    return { code: -1, message: '缺少 command 参数' }
  }

  const apiCommand = COMMAND_MAP[command]
  if (!apiCommand) {
    return { code: -1, message: `不支持的命令: ${command}` }
  }

  try {
    // 从数据库获取用户 token
    const userRes = await db.collection('users').where({ openid }).get()
    if (!userRes.data || userRes.data.length === 0) {
      return { code: -1, message: '用户不存在' }
    }

    const user = userRes.data[0]
    let accessToken = user.teslaAccessToken
    const refreshToken = user.teslaRefreshToken

    if (!accessToken) {
      return { code: -2, needAuth: true, message: '未绑定 Tesla 账号' }
    }

    // 检查 token 过期
    if (user.teslaTokenExpiresAt && user.teslaTokenExpiresAt < Date.now()) {
      if (refreshToken) {
        try {
          const refreshRes = await refreshAccessToken(refreshToken)
          accessToken = refreshRes.access_token
          await db.collection('users').where({ openid }).update({
            data: {
              teslaAccessToken: accessToken,
              teslaTokenExpiresAt: Date.now() + (refreshRes.expires_in || 28800) * 1000,
              gmt_modified: db.serverDate()
            }
          })
        } catch (e) {
          return { code: -2, needAuth: true, message: 'Token 已过期，请重新授权' }
        }
      } else {
        return { code: -2, needAuth: true, message: 'Token 已过期，请重新授权' }
      }
    }

    // 如果没有 vehicleId，获取第一辆车
    let vin = ''
    if (!vehicleId) {
      const listRes = await httpsGet(`${FLEET_API_BASE}/api/1/vehicles`, accessToken)
      const vehicles = listRes?.response || []
      if (vehicles.length > 0) {
        vehicleId = vehicles[0].id_s
        vin = vehicles[0].vin
      }
    }

    // 已有 vehicleId 但无 VIN 时补充获取
    if (!vin) {
      try {
        const listRes2 = await httpsGet(`${FLEET_API_BASE}/api/1/vehicles`, accessToken)
        const vehicles2 = listRes2?.response || []
        if (vehicles2.length > 0) {
          vin = vehicles2[0].vin
          if (!vehicleId) vehicleId = vehicles2[0].id_s
        }
      } catch (e) {
        console.warn('[controlVehicle] 获取 VIN 失败:', e.message)
      }
    }
 
    if (!vin) {
      return { code: -3, message: '无法获取车辆 VIN' }
    }

    // 调用 Tesla Fleet API 执行命令（Vehicle Command Protocol）
    let url
    if (apiCommand === 'wake_up' && vehicleId) {
      url = `${FLEET_API_BASE}/api/1/vehicles/${vehicleId}/wake_up?vin=${vin}`
    } else {
      // Vehicle Command Protocol: 使用 VIN 在 URL 路径中（Vehicle Command Protocol 要求）
      url = `${FLEET_API_BASE}/api/1/vehicles/${vin}/command/${apiCommand}`
    }
    const response = await httpsPost(url, accessToken, params || {})
    console.log('[controlVehicle] 请求 URL:', url, 'response status:', response.statusCode)

    const result = response?.response || {}

    // wake_up 端点返回 response.state ("online"/"asleep")，而非 response.result
    if (apiCommand === 'wake_up') {
      const isOnline = result.state === 'online'
      return {
        code: 0,
        result: isOnline,
        message: isOnline ? '车辆已唤醒' : (result.state || '唤醒失败'),
        rawResponse: result
      }
    }

    return {
      code: result.result === false ? -3 : 0,
      result: result.result || false,
      message: result.reason || (result.result ? '命令执行成功' : '命令执行失败'),
      rawResponse: result
    }
  } catch (err) {
    console.error('[controlVehicle] 失败:', err)

    if (err.statusCode === 401) {
      return { code: -2, needAuth: true, message: 'Tesla 授权已过期' }
    }

    return {
      code: -1,
      message: '命令执行失败',
      error: err.message || err.error || String(err),
      statusCode: err.statusCode,
      responseData: err.responseData
    };
  }
}

/**
 * 刷新 access_token
 */
/**
 * 原生 HTTPS POST 请求（发送命令用）
 */
function httpsPost(url, token, body) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url)
    const bodyStr = JSON.stringify(body)
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || 443,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
        'Tesla-Vehicle-Command-Protocol': 'true'
      },
      timeout: 30000
    }
    const req = https.request(options, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try {
          const json = JSON.parse(data)
          if (res.statusCode >= 400) {
            reject({ statusCode: res.statusCode, headers: res.headers, responseData: json, error: json.error })
          } else {
            resolve({ statusCode: res.statusCode, headers: res.headers, response: json.response || json })
          }
        } catch (e) {
          reject({ statusCode: res.statusCode, error: 'JSON parse error', raw: data })
        }
      })
    })
    req.on('timeout', () => { req.destroy(); reject({ error: 'Request timeout' }) })
    req.on('error', (e) => reject({ error: e.message }))
    req.write(bodyStr)
    req.end()
  })
}

/**
 * 原生 HTTPS GET 请求
 */
function httpsGet(url, token) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url)
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || 443,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json'
      },
      timeout: 15000
    }
    const req = https.request(options, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try {
          const json = JSON.parse(data)
          resolve(json)
        } catch (e) {
          reject({ error: 'JSON parse error', raw: data })
        }
      })
    })
    req.on('timeout', () => { req.destroy(); reject({ error: 'Request timeout' }) })
    req.on('error', (e) => reject({ error: e.message }))
    req.end()
  })
}

/**
 * 刷新 access_token
 */
async function refreshAccessToken(refreshToken) {
  const urlObj = new URL('https://auth.tesla.cn/oauth2/v3/token')
  const bodyStr = JSON.stringify({
    grant_type: 'refresh_token',
    client_id: TESLA_CLIENT_ID,
    client_secret: TESLA_CLIENT_SECRET,
    refresh_token: refreshToken,
    audience: FLEET_API_BASE
  })
  const options = {
    hostname: urlObj.hostname,
    port: 443,
    path: urlObj.pathname,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(bodyStr)
    },
    timeout: 15000
  }
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try { resolve(JSON.parse(data)) }
        catch (e) { reject(e) }
      })
    })
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
    req.on('error', (e) => reject(e))
    req.write(bodyStr)
    req.end()
  })
}
