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

const axios = require('axios')

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

    // 获取 VIN（vehicle_data 需要使用 VIN 而不是数字 ID）
    let vin = ''
    try {
      const listRes = await axios.get(`${FLEET_API_BASE}/api/1/vehicles`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: 15000
      })
      const vehicles = listRes.data?.response || []
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

    // 调用 Tesla Fleet API 获取车辆详细数据（必须使用 VIN）
    if (!vin) {
      return { code: -1, message: '无法获取车辆 VIN' }
    }
    const response = await axios.get(
      `${FLEET_API_BASE}/api/1/vehicles/${vin}/vehicle_data`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: 30000,
        params: { location_data: 'true' }
      }
    )

    const vehicleData = response.data?.response || {}

    return {
      code: 0,
      data: vehicleData,
      vehicleId
    }
  } catch (err) {
    console.error('[getVehicleData] 失败:', err)

    if (err.response?.status === 401) {
      return { code: -2, needAuth: true, message: 'Tesla 授权已过期' }
    }

    return {
      code: -1,
      message: '获取车辆数据失败',
      error: err.message,
      statusCode: err.response?.status
    }
  }
}

/**
 * 刷新 access_token
 */
async function refreshAccessToken(refreshToken) {
  const res = await axios.post('https://auth.tesla.cn/oauth2/v3/token', {
    grant_type: 'refresh_token',
    client_id: TESLA_CLIENT_ID,
    client_secret: TESLA_CLIENT_SECRET,
    refresh_token: refreshToken,
    audience: FLEET_API_BASE
  }, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 15000
  })

  return res.data
}