/**
 * 云函数：获取车辆详细数据
 * 调用 Fleet API: GET /api/1/vehicles/{vehicle_id}/vehicle_data
 *
 * 调用方式：
 *   wx.cloud.callFunction({ name: 'getVehicleData', data: { openid, vehicleId } })
 *
 * 返回：
 *   { code: 0, data: { ...完整 vehicle_data 响应 } }
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

exports.main = async (event, context) => {
  let { openid, vehicleId } = event
  if (!openid) {
    const wxContext = cloud.getWXContext()
    openid = wxContext.OPENID
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
          const newRefreshToken = refreshRes.refresh_token || refreshToken
          await db.collection('users').where({ openid }).update({
            data: {
              teslaAccessToken: accessToken,
              teslaRefreshToken: newRefreshToken,
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

    // 获取 VIN
    let vin = ''
    try {
      const listRes = await httpsGet(`${FLEET_API_BASE}/api/1/vehicles`, accessToken)
      const vehicles = listRes?.response || []
      if (vehicles.length > 0) {
        vin = vehicles[0].vin
        if (!vehicleId || vehicleId === 'mock') {
          vehicleId = vehicles[0].id_s
        }
      } else {
        return { code: -3, message: '没有找到车辆' }
      }
    } catch (e) {
      // 如果获取列表失败，但有传入 vehicleId，仍然尝试获取
      if (!vehicleId || vehicleId === 'mock') {
        return { code: -1, message: '获取车辆列表失败', error: e.message }
      }
    }

    // 调用 Tesla Fleet API 获取车辆详细数据
    if (!vin) {
      return { code: -1, message: '无法获取车辆 VIN' }
    }
    const response = await httpsGet(
      `${FLEET_API_BASE}/api/1/vehicles/${vin}/vehicle_data`,
      accessToken
    )

    const vehicleData = response?.response || {}

    return {
      code: 0,
      data: vehicleData,
      vehicleId
    }
  } catch (err) {
    console.error('[getVehicleData] 失败:', err)

    if (err.statusCode === 401) {
      return { code: -2, needAuth: true, message: 'Tesla 授权已过期' }
    }

    return {
      code: -1,
      message: '获取车辆数据失败',
      error: err.message || err.error || String(err),
      statusCode: err.statusCode
    }
  }
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
            resolve(json)
          }
        } catch (e) {
          reject({ statusCode: res.statusCode, error: 'JSON parse error' })
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