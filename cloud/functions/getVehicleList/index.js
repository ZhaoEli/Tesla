/**
 * 云函数：获取 Tesla 车辆列表
 * 调用 Fleet API: GET /api/1/vehicles
 *
 * 调用方式：
 *   wx.cloud.callFunction({ name: 'getVehicleList', data: { openid } })
 *
 * 返回：
 *   { code: 0, data: { vehicles: [...], teslaEmail: '...', count: N } }
 *   或 { code: -2, needAuth: true, message: '...' } 表示需要重新授权
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
  let { openid } = event
  if (!openid) {
    const wxContext = cloud.getWXContext()
    openid = wxContext.OPENID
  }

  try {
    // 从数据库获取用户的 Tesla token
    const userRes = await db.collection('users').where({ openid }).get()
    if (!userRes.data || userRes.data.length === 0) {
      return { code: -1, message: '用户不存在，请先微信登录' }
    }

    const user = userRes.data[0]
    let accessToken = user.teslaAccessToken
    const refreshToken = user.teslaRefreshToken

    if (!accessToken) {
      return {
        code: -2,
        needAuth: true,
        message: '未绑定 Tesla 账号，请先在设置页完成授权'
      }
    }

    // 检查 token 是否过期，过期则刷新
    if (user.teslaTokenExpiresAt && user.teslaTokenExpiresAt < Date.now()) {
      if (refreshToken) {
        try {
          const refreshRes = await refreshAccessToken(refreshToken)
          accessToken = refreshRes.access_token
          const newRefreshToken = refreshRes.refresh_token || refreshToken
          // 更新数据库
          await db.collection('users').where({ openid }).update({
            data: {
              teslaAccessToken: accessToken,
              teslaRefreshToken: newRefreshToken,
              teslaTokenExpiresAt: Date.now() + (refreshRes.expires_in || 28800) * 1000,
              gmt_modified: db.serverDate()
            }
          })
        } catch (e) {
          return {
            code: -2,
            needAuth: true,
            message: 'Token 已过期且刷新失败，请重新授权',
            refreshError: e.message
          }
        }
      } else {
        return {
          code: -2,
          needAuth: true,
          message: 'Token 已过期，请重新授权'
        }
      }
    }

    // 调用 Tesla Fleet API 获取车辆列表
    const response = await axios.get(`${FLEET_API_BASE}/api/1/vehicles`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 15000
    })

    const vehicles = response.data?.response || []

    return {
      code: 0,
      data: {
        vehicles,
        count: vehicles.length,
        teslaEmail: user.teslaAccountName || '',
        teslaUserId: user.teslaUserId || ''
      }
    }
  } catch (err) {
    console.error('[getVehicleList] 失败:', err)

    // 如果是 401，说明 token 无效
    if (err.response?.status === 401) {
      return {
        code: -2,
        needAuth: true,
        message: 'Tesla 授权已过期，请重新绑定账号'
      }
    }

    return {
      code: -1,
      message: '获取车辆列表失败',
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
