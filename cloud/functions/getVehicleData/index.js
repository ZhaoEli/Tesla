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

    // 如果没有 vehicleId，先获取车辆列表
    if (!vehicleId) {
      const listRes = await axios.get(`${FLEET_API_BASE}/api/1/vehicles`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: 15000
      })
      const vehicles = listRes.data?.response || []
      if (vehicles.length === 0) {
        return { code: -3, message: '没有找到车辆' }
      }
      vehicleId = vehicles[0].id_s
    }

    // mock 车辆直接返回模拟数据
    if (vehicleId === 'mock') {
      return {
        code: 0,
        data: {
          display_name: 'Model 3',
          vin: 'LRW3E7FS0NC123456',
          state: 'online',
          charge_state: { battery_level: 78, battery_range: 310.75, charging_state: 'Disconnected', charge_limit_soc: 90, charge_port_door_open: false },
          vehicle_state: { odometer: 9466, locked: true, sentry_mode: false },
          climate_state: { inside_temp: 26, outside_temp: 32, is_climate_on: false },
          drive_state: { latitude: 30.2741, longitude: 120.1551 }
        },
        vehicleId: 'mock'
      }
    }

    // 调用 Tesla Fleet API 获取车辆详细数据
    const response = await axios.get(
      `${FLEET_API_BASE}/api/1/vehicles/${vehicleId}/vehicle_data`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: 30000, // 车辆可能休眠，需要等待唤醒
        params: { endpoints: 'location;chargeState;climateState;vehicleState;guiSettings;driveState' }
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